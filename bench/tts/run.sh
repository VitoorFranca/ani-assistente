#!/usr/bin/env bash
# Runs every engine and voice on frases.txt: WAVs in audio/, reports in results/raw/.
#   ./run.sh [engine:voice …]          TEXT=frases-faladas.txt ./run.sh …  (the same
#   sentences after the app's spokenText(): numbers in words, ";" as ","); TEXT=fleurs.txt for
#   100 sentences (node fleurs.mjs)
set -u
cd "$(dirname "$0")"
BIN="$(cd engines/fluid && swift build -c release --show-bin-path)/tts"
mkdir -p results/raw
TEXT="${TEXT:-frases.txt}"
case "$TEXT" in
  frases.txt) suffix="" ;;
  frases-faladas.txt) suffix="-falado" ;;
  *) suffix="-$(basename "$TEXT" .txt)" ;; # fleurs.txt (node fleurs.mjs) → -fleurs
esac
runs=("${@:-apple:Luciana pocket:alba pocket:vera pocket:rafael pocket24:alba supertonic:F1 supertonic:M1 chatterbox:default}")
for run in ${runs[@]}; do
  engine="${run%%:*}" voice="${run#*:}" name="$engine-$voice$suffix"
  echo "== $name"
  /usr/bin/time -l "$BIN" --engine "$engine" --voice "$voice" --text "$TEXT" --out "audio/$name" \
    --models-dir models >"results/raw/$name.json" 2>"results/raw/$name.log" || { echo "falhou"; tail -3 "results/raw/$name.log"; }
  sed -i '' '1s/^[^{]*//' "results/raw/$name.json" # CoreML may print warnings to stdout first
  grep "maximum resident" "results/raw/$name.log"
done
