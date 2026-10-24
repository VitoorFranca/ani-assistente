#!/bin/sh
# The "comandos" set: each line of comandos.txt spoken by the macOS voice Luciana (pt-BR), 16 kHz mono.
set -e
cd "$(dirname "$0")"
mkdir -p audio
i=0
while IFS= read -r line; do
  i=$((i + 1))
  say -v Luciana -r 185 --data-format=LEI16@16000 -o "audio/$(printf %02d $i)-Luciana.wav" "$line"
done < comandos.txt
