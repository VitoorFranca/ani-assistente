// Word error rate in pt-BR, shared by the speech benchmarks (stt and tts).
// Lowercase, no punctuation, numbers in words ("3" = "três"); accents count.

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
    .replace(/%/g, " por cento")
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
