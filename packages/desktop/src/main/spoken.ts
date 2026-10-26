// Text as it should be read aloud in pt-BR. The neural voices read digits and
// symbols poorly ("20 mil" came out as "2 mil" in bench/tts), so numbers,
// percentages and the punctuation they stumble on become plain words first.

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

function below1000(n: number): string {
  if (n === 100) return "cem";
  const parts: string[] = [];
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)]!);
  const rest = n % 100;
  if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)]! + (rest % 10 ? ` e ${UNITS[rest % 10]}` : ""));
  else if (rest > 0 || n === 0) parts.push(UNITS[rest]!);
  return parts.join(" e ");
}

/** 0 to 999 999 in words: 1 500 → "mil e quinhentos", 21 → "vinte e um". */
export function numberWords(n: number): string {
  if (n < 1000) return below1000(n);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 1 ? "mil" : `${below1000(thousands)} mil`;
  if (!rest) return head;
  // "e" only before a round hundred or anything below 100: "mil e cem", "mil e vinte", "mil duzentos e três".
  const joiner = rest < 100 || rest % 100 === 0 ? " e " : " ";
  return head + joiner + below1000(rest);
}

/** Integer from "12", "1.500" or "1500"; null when it is not a plain number we can say. */
function parseInteger(digits: string): number | null {
  const n = Number(digits.replace(/\./g, ""));
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : null;
}

function decimalWords(whole: string, fraction: string): string | null {
  const w = parseInteger(whole);
  if (w === null || fraction.length > 2) return null;
  const f = Number(fraction);
  return `${numberWords(w)} vírgula ${fraction.startsWith("0") && fraction.length > 1 ? "zero " : ""}${numberWords(f)}`;
}

export function spokenText(text: string): string {
  return (
    text
      // Markdown the model may still write: **bold**, `code`, list bullets.
      .replace(/[*_`#]+/g, "")
      .replace(/^\s*[-•]\s+/gm, "")
      // 4,5% · 85% · 3,5 · 1.500 · 12
      .replace(/(\d+),(\d+)\s*%/g, (m, a: string, b: string) => {
        const w = decimalWords(a, b);
        return w ? `${w} por cento` : m;
      })
      .replace(/(\d+(?:\.\d{3})*)\s*%/g, (m, d: string) => {
        const n = parseInteger(d);
        return n === null ? m : `${numberWords(n)} por cento`;
      })
      .replace(/\b(\d+),(\d+)\b/g, (m, a: string, b: string) => decimalWords(a, b) ?? m)
      .replace(/\b\d{1,3}(?:\.\d{3})+\b|\b\d+\b/g, (m) => {
        const n = parseInteger(m);
        return n === null ? m : numberWords(n);
      })
      // Pauses the voices skip over: a semicolon or a dash between clauses becomes a comma.
      .replace(/\s*;\s*/g, ", ")
      .replace(/\s+[—–]\s+/g, ", ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
