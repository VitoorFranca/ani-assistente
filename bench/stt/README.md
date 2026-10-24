# Reconhecimento de fala em pt-BR

Comparação que escolheu o motor do componente `voz`. Mesmo método do
[spokemark](https://github.com/VitoorFranca/spokemark): medir na máquina real
antes de escolher. A diferença é o caso de uso: o assistente recebe comandos
curtos em português e transcreve a frase inteira depois que a pessoa para de
falar, então modelos de transcrição em bloco concorrem.

## Resultado (24/10/2026)

MacBook Air M4 (16 GB), macOS 26.6.2. Erro por palavra (WER) com texto em
minúsculas, sem pontuação e com números normalizados ("3" = "três"); o
acento conta. Tempo por frase com o modelo já carregado.

| Motor                           | FLEURS pt_br (100 frases) | Comandos (24) | Tempo p50 / p95 (FLEURS) | Pico de memória | Carga a frio |
| ------------------------------- | ------------------------- | ------------- | ------------------------ | --------------- | ------------ |
| Apple SpeechAnalyzer (pt-BR)    | 5,9%                      | 10,6%         | 93 / 132 ms              | 20 MB¹          | 0,3 s        |
| Parakeet TDT v3 (FluidAudio)    | 4,7%                      | 4,5%          | 61 / 127 ms              | 123 MB          | 0,4 s²       |
| **Parakeet Ultra (FluidAudio)** | **4,4%**                  | **3,4%**      | **63 / 122 ms**          | 114 MB          | 0,6 s²       |
| Whisper large-v3-turbo          | 3,6%                      | 2,2%          | 1.876 / 2.447 ms         | 1.922 MB        | 0,4 s        |
| Whisper large-v3-turbo q5_0     | 3,7%                      | 2,8%          | 1.922 / 2.243 ms         | 846 MB          | 0,1 s        |
| Whisper small                   | 7,8%                      | 15,1%         | 591 / 855 ms             | 850 MB          | 0,1 s        |

¹ O modelo da Apple roda num serviço do macOS, fora dessa medida.
² Depois da primeira vez. A primeira baixa e compila o modelo CoreML (3 a 5 min).

**Escolha:** Parakeet Ultra como padrão. O Whisper turbo erra cerca de 1
ponto a menos, mas leva cerca de 1,9 s por frase (30 vezes mais), usa GPU e
de 0,8 a 1,9 GB de memória. Num assistente, a espera depois de falar pesa
mais. O Whisper turbo q5_0 fica como opção de precisão máxima.

## Limitações

- **Comandos com voz sintética:** a voz Luciana do macOS testa o
  vocabulário, não sotaques. As vozes Eddy, Flo e Reed foram descartadas:
  todos os motores falharam nelas (robóticas demais para medir algo útil).
- **FLEURS é leitura em voz alta:** pessoas reais, mas não fala espontânea nem
  microfone de notebook em sala com ruído.
- **Amostra pequena:** 100 frases do FLEURS (sorteadas com semente fixa) e 24
  comandos. Diferenças de menos de 1 ponto não são conclusivas.
- **Termos em inglês:** "back-end com Go" saiu errado em todos, menos no
  Whisper turbo. O FluidAudio tem vocabulário personalizado: a testar.
- **Próximo teste:** gravações reais de quem usa (comandos falados ao
  microfone), com o mesmo script.

## Reproduzir

```bash
./download.sh        # FLEURS pt_br (621 MB) e modelos Whisper (≈2,6 GB)
./make-audio.sh      # os 24 comandos na voz Luciana
swiftc -O -parse-as-library -target arm64-apple-macos26.0 engines/apple.swift -o bin/apple
(cd engines/parakeet && swift build -c release) && cp "$(cd engines/parakeet && swift build -c release --show-bin-path)/parakeet" bin/
cmake -S <whisper.cpp v1.9.5> -B .build/whisper -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON && cmake --build .build/whisper --target whisper-cli
node bench.mjs                # tudo; --sets, --engines, --fleurs N para recortes
node bench.mjs --rescore      # recalcula as notas a partir de results/raw
```

Resultados: `results/<conjunto>.json` (resumo) e `results/raw/` (cada
transcrição, com referência e erros).

Fontes de dados: [FLEURS](https://huggingface.co/datasets/google/fleurs)
(Google, CC BY 4.0); modelos do [whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)
e do [FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0).
