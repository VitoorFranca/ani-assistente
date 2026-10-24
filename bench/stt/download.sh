#!/bin/sh
# Downloads the benchmark data and models (not versioned). Sources:
#  - FLEURS pt_br test split (Google, CC BY 4.0): https://huggingface.co/datasets/google/fleurs
#  - whisper.cpp ggml models: https://huggingface.co/ggerganov/whisper.cpp
set -e
cd "$(dirname "$0")"
get() { [ -s "$2" ] || curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2" 2>/dev/null || true; }
get https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br/test.tsv data/fleurs/test.tsv
get https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br/audio/test.tar.gz data/fleurs/test.tar.gz
[ -d data/fleurs/test ] || tar -xzf data/fleurs/test.tar.gz -C data/fleurs
for m in large-v3-turbo large-v3-turbo-q5_0 small; do
  get "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$m.bin" "models/ggml-$m.bin"
done
echo pronto
