#!/usr/bin/env node
// Writes fleurs.txt: the 100 FLEURS pt_br sentences of bench/stt (Google,
// CC BY 4.0), after the app's spokenText(). A larger sample than frases.txt
// for the error rate: four sentences move it by 1.5 points per word.
import { readFileSync, writeFileSync } from "node:fs";
import { spokenText } from "../../packages/desktop/src/main/spoken.ts";

const here = new URL(".", import.meta.url).pathname;
const rows = JSON.parse(readFileSync(`${here}../stt/results/raw/fleurs-apple.json`, "utf8"));
writeFileSync(`${here}fleurs.txt`, `${rows.map((r) => spokenText(r.ref)).join("\n")}\n`);
