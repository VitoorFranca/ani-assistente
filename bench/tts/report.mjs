#!/usr/bin/env node
// Summarizes ./run.sh: speed from results/raw/*.json, peak memory from the
// logs, and intelligibility as the word error rate when Parakeet Ultra (the
// app's speech recognizer, from bench/stt) transcribes each WAV back.
//
//   node report.mjs        writes results/summary.json and prints a table
//
// A low error rate says the words come out right; it says nothing about how
// natural or pleasant the voice sounds. That part is listening.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wordErrors } from "../stt/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const stt = join(here, "../stt");
const parakeet = join(stt, "bin/parakeet");
if (!existsSync(parakeet)) throw new Error("Falta bench/stt/bin/parakeet (veja bench/stt/README.md).");

/** CoreML may print warnings to stdout before the report. */
const readReport = (path) => {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.slice(text.indexOf("{")));
};
const mkdir = (path) => mkdirSync(path, { recursive: true });
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const rows = [];
for (const file of readdirSync(join(here, "results/raw")).filter((f) => f.endsWith(".json"))) {
  const name = file.replace(/\.json$/, "");
  let report;
  try {
    report = readReport(join(here, "results/raw", file));
  } catch {
    console.error(`${name}: sem relatório (falhou?)`);
    continue;
  }
  const wavs = report.sentences.map((s) => join(here, "audio", name, s.file));
  const asr = spawnSync(parakeet, ["--version", "ultra", "--models-dir", join(stt, "models/parakeet-ultra"), ...wavs], {
    encoding: "utf8",
  });
  const heard = asr.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let errors = 0;
  let words = 0;
  const sentences = report.sentences.map((s, i) => {
    const hyp = heard[i]?.text ?? "";
    const w = wordErrors(s.text, hyp);
    errors += w.errors;
    words += w.words;
    return { ...s, heard: hyp, errors: w.errors };
  });
  const logPath = join(here, "results/raw", `${name}.log`);
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const peak = Number(log.match(/(\d+)\s+maximum resident set size/)?.[1] ?? 0);
  const audio = report.sentences.reduce((t, s) => t + s.audioSec, 0);
  const synth = report.sentences.reduce((t, s) => t + s.synthMs, 0) / 1000;
  rows.push({
    name,
    engine: report.engine,
    voice: report.voice,
    loadMs: Math.round(report.loadMs),
    firstAudioMs: Math.round(median(report.sentences.map((s) => s.firstAudioMs))),
    sentenceMs: Math.round(median(report.sentences.map((s) => s.synthMs))),
    realTimeFactor: Number((synth / audio).toFixed(2)),
    peakMb: Math.round(peak / 1024 / 1024),
    wer: Number(((100 * errors) / words).toFixed(1)),
    sentences,
  });
}

// To listen: each voice's four answers (frases-faladas.txt) in one file, with a pause between them.
mkdir(join(here, "audio/ouvir"));
for (const r of rows.filter((r) => r.name.endsWith("-falado"))) {
  const pcm = r.sentences.map((s) => readFileSync(join(here, "audio", r.name, s.file)));
  const rate = pcm[0].readUInt32LE(24);
  const pause = Buffer.alloc(Math.round(rate * 0.6) * 2);
  const data = Buffer.concat(pcm.flatMap((wav) => [wav.subarray(44), pause]));
  const header = Buffer.from(pcm[0].subarray(0, 44));
  header.writeUInt32LE(36 + data.length, 4);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(join(here, "audio/ouvir", `${r.name.replace(/-falado$/, "")}.wav`), Buffer.concat([header, data]));
}

writeFileSync(join(here, "results/summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log("| Voz | Primeiro som (p50) | Frase inteira (p50) | Tempo/áudio | Memória | Erro ao transcrever | Carga |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.firstAudioMs} ms | ${r.sentenceMs} ms | ${r.realTimeFactor} | ${r.peakMb} MB | ${r.wer}% | ${(r.loadMs / 1000).toFixed(1)} s |`,
  );
}
for (const r of rows) for (const s of r.sentences) if (s.errors) console.log(`${r.name}: "${s.heard}"`);
