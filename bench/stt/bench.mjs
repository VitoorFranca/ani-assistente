#!/usr/bin/env node
// Speech recognition in pt-BR for the assistant: word error rate, time per
// utterance once warm, load time and peak memory, per engine and test set.
//
//   ./download.sh && ./make-audio.sh && node bench.mjs [--sets comandos,fleurs] [--engines …] [--fleurs 100]
//
// Sets:
//   comandos  24 assistant commands, macOS voice Luciana (synthetic: vocabulary, not accents)
//   fleurs    a fixed sample of FLEURS pt_br test (real people reading; Google, CC BY 4.0)
// Results: results/<set>.json (summary) and results/raw/ (every transcription).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sets = arg("sets", "comandos,fleurs").split(",");
const fleursSize = Number(arg("fleurs", "100"));

// ---- Engines: each turns a list of files into [{file, text, ms}] plus load time and peak memory ----

/** Runs a command under /usr/bin/time -l and returns stdout, stderr and peak memory (MB). */
function timed(command, args) {
  const result = spawnSync("/usr/bin/time", ["-l", command, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const rss = Number(result.stderr.match(/(\d+)\s+maximum resident set size/)?.[1] ?? 0);
  return { stdout: result.stdout, stderr: result.stderr, peakMb: Math.round(rss / 1024 / 1024), status: result.status };
}

const jsonLines = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));

/** The first file twice: the first pass warms the model, its time is the load. */
function warmFirst(files) {
  return [files[0], ...files];
}

const ENGINES = {
  apple: {
    label: "Apple SpeechAnalyzer (pt-BR)",
    run(files) {
      const r = timed(join(here, "bin/apple"), ["--locale", "pt-BR", ...warmFirst(files)]);
      const rows = jsonLines(r.stdout);
      return {
        rows: rows.slice(1),
        loadMs: rows[0]?.ms ?? null,
        peakMb: r.peakMb,
        note: "Memória do modelo fica num serviço do macOS, fora desta medida.",
      };
    },
  },
  "parakeet-v3": {
    label: "Parakeet TDT v3 (FluidAudio)",
    run: (files) => parakeet("v3", files),
  },
  "parakeet-ultra": {
    label: "Parakeet Ultra (FluidAudio)",
    run: (files) => parakeet("ultra", files),
  },
  "whisper-turbo": { label: "Whisper large-v3-turbo", run: (files) => whisper("large-v3-turbo", files) },
  "whisper-turbo-q5": { label: "Whisper large-v3-turbo q5_0", run: (files) => whisper("large-v3-turbo-q5_0", files) },
  "whisper-small": { label: "Whisper small", run: (files) => whisper("small", files) },
};

function parakeet(version, files) {
  const r = timed(join(here, "bin/parakeet"), [
    "--version",
    version,
    "--models-dir",
    join(here, `models/parakeet-${version}`),
    ...warmFirst(files),
  ]);
  const rows = jsonLines(r.stdout);
  const load = Number(r.stderr.match(/pronto em (\d+) ms/)?.[1] ?? 0);
  return { rows: rows.slice(1), loadMs: load + (rows[0]?.ms ?? 0), peakMb: r.peakMb };
}

function whisper(model, files) {
  const bin = join(here, ".build/whisper/bin/whisper-cli");
  const modelPath = join(here, `models/ggml-${model}.bin`);
  const base = ["-m", modelPath, "-l", "pt", "-nt", "-t", "8"];
  const timing = (stderr, name) => Number(stderr.match(new RegExp(`${name} time =\\s*([\\d.]+) ms`))?.[1] ?? NaN);
  timed(bin, [...base, "-f", files[0]]); // warm-up (first Metal compile)
  let peakMb = 0;
  const loads = [];
  const rows = files.map((file) => {
    const r = timed(bin, [...base, "-f", file]);
    peakMb = Math.max(peakMb, r.peakMb);
    const load = timing(r.stderr, "load");
    loads.push(load);
    // whisper.cpp reports its own times: total minus model load = what a resident model would take.
    return { file, text: r.stdout.replace(/\s+/g, " ").trim(), ms: Math.round(timing(r.stderr, "total") - load) };
  });
  return {
    rows,
    loadMs: quantile(loads, 0.5),
    peakMb,
    note: "Tempo por frase = total do whisper.cpp menos a carga do modelo (o app manteria o modelo carregado).",
  };
}

// ---- Test sets ----

function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function loadSet(name) {
  if (name === "comandos") {
    const lines = readFileSync(join(here, "comandos.txt"), "utf8").trim().split("\n");
    return lines.map((text, i) => ({
      file: join(here, `audio/${String(i + 1).padStart(2, "0")}-Luciana.wav`),
      ref: text,
    }));
  }
  if (name === "fleurs") {
    const rows = readFileSync(join(here, "data/fleurs/test.tsv"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => existsSync(join(here, "data/fleurs/test", cols[1])));
    const random = seeded(2026);
    const shuffled = rows
      .map((r) => [random(), r])
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => r);
    return shuffled
      .slice(0, fleursSize)
      .map((cols) => ({ file: join(here, "data/fleurs/test", cols[1]), ref: cols[3] }));
  }
  throw new Error(`conjunto desconhecido: ${name}`);
}

// ---- Word error rate ----

const UNITS = [
  "zero",
  "um",
  "dois",
  "três",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "onze",
  "doze",
  "treze",
  "catorze",
  "quinze",
  "dezesseis",
  "dezessete",
  "dezoito",
  "dezenove",
];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
];

/** 0–999 in words (pt-BR): "3" and "três" must count as the same word. */
function numberWords(n) {
  if (n === 100) return "cem";
  const parts = [];
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? ` e ${UNITS[rest % 10]}` : ""));
  else if (rest > 0 || n === 0) parts.push(UNITS[rest]);
  return parts.join(" e ");
}

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\b(\d{1,3})h\b/g, "$1")
    .replace(/\b\d{1,3}\b/g, (d) => numberWords(Number(d)))
    .replace(/[“”"'`´.,;:!?¿¡()[\]{}…—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordErrors(ref, hyp) {
  const r = normalize(ref).split(" ").filter(Boolean);
  const h = normalize(hyp).split(" ").filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return { errors: d[r.length][h.length], words: r.length };
}

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  return Math.round(s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i)));
};

// ---- Run ----

/** Recomputes the scores from results/raw (after a change to the normalization), without transcribing again. */
function rescore() {
  for (const setName of sets) {
    const path = join(here, `results/${setName}.json`);
    if (!existsSync(path)) continue;
    const summary = JSON.parse(readFileSync(path, "utf8"));
    for (const engine of summary.engines) {
      const rawPath = join(here, `results/raw/${setName}-${engine.id}.json`);
      if (!existsSync(rawPath)) continue;
      const detail = JSON.parse(readFileSync(rawPath, "utf8")).map((d) => ({ ...d, ...wordErrors(d.ref, d.hyp) }));
      const errors = detail.reduce((s, d) => s + d.errors, 0);
      const words = detail.reduce((s, d) => s + d.words, 0);
      engine.wer = Math.round((errors / words) * 1000) / 10;
      engine.exact = detail.filter((d) => d.errors === 0).length;
      writeFileSync(rawPath, JSON.stringify(detail, null, 2));
      process.stderr.write(
        `${setName} · ${engine.label}: WER ${engine.wer}% · ${engine.exact}/${detail.length} exatas\n`,
      );
    }
    writeFileSync(path, JSON.stringify(summary, null, 2));
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv.includes("--rescore")) {
  rescore();
} else if (process.argv[1] === new URL(import.meta.url).pathname) {
  const engines = arg("engines", Object.keys(ENGINES).join(",")).split(",");
  mkdirSync(join(here, "results/raw"), { recursive: true });
  const machine = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
  const macos = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  for (const setName of sets) {
    const items = loadSet(setName);
    const summary = {
      set: setName,
      utterances: items.length,
      machine,
      macos,
      date: new Date().toISOString().slice(0, 10),
      engines: [],
    };
    for (const id of engines) {
      const engine = ENGINES[id];
      process.stderr.write(`\n== ${setName} · ${engine.label} (${items.length} frases)\n`);
      const out = engine.run(items.map((i) => i.file));
      const byFile = new Map(out.rows.map((r) => [r.file, r]));
      let errors = 0;
      let words = 0;
      const detail = items.map((item) => {
        const row = byFile.get(item.file) ?? { text: "", ms: null };
        const w = wordErrors(item.ref, row.text);
        errors += w.errors;
        words += w.words;
        return {
          file: basename(item.file),
          ref: item.ref,
          hyp: row.text,
          errors: w.errors,
          words: w.words,
          ms: row.ms,
        };
      });
      const times = detail.map((d) => d.ms).filter((ms) => ms !== null);
      const result = {
        id,
        label: engine.label,
        wer: Math.round((errors / words) * 1000) / 10,
        msP50: quantile(times, 0.5),
        msP95: quantile(times, 0.95),
        loadMs: out.loadMs,
        peakMb: out.peakMb,
        exact: detail.filter((d) => d.errors === 0).length,
        note: out.note,
      };
      summary.engines.push(result);
      writeFileSync(join(here, `results/raw/${setName}-${id}.json`), JSON.stringify(detail, null, 2));
      process.stderr.write(
        `   WER ${result.wer}% · p50 ${result.msP50} ms · p95 ${result.msP95} ms · carga ${result.loadMs} ms · pico ${result.peakMb} MB · ${result.exact}/${items.length} exatas\n`,
      );
    }
    writeFileSync(join(here, `results/${setName}.json`), JSON.stringify(summary, null, 2));
  }
}
