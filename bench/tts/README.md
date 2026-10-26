# Voz da Ani em pt-BR

Comparação das vozes que o componente `voz` pode usar para responder. Mesmo
método de [`bench/stt`](../stt/README.md): medir na máquina real antes de
escolher. O app fala frase por frase enquanto a resposta chega, então o que
pesa é o tempo até o primeiro som de cada frase, a memória (o app fica
aberto na barra de menus) e se as palavras saem certas.

## Resultado (25/10/2026)

MacBook Air M4 (16 GB), macOS 26.6.2, modelo já carregado.

| Voz                                          | Primeiro som | Memória | Erro ao transcrever (FLEURS, 100 frases) | Download | Licença    |
| -------------------------------------------- | ------------ | ------- | ---------------------------------------- | -------- | ---------- |
| macOS Luciana (compacta)                     | 8 ms         | 55 MB   | 6,0%                                     | nenhum   | do sistema |
| **Supertonic 3 (F1, M1)**                    | **95 ms**¹   | 115 MB  | 6,9% / 7,0%                              | 165 MB   | OpenRAIL-M |
| PocketTTS pt, 6 camadas (alba, vera, rafael) | 50–66 ms²    | 740 MB  | 9,3–9,9%                                 | 530 MB   | CC BY 4.0  |
| PocketTTS pt, 24 camadas (alba)              | 0,9 s²       | 1,8 GB  | 9,1%³                                    | 1,8 GB   | CC BY 4.0  |
| Chatterbox multilíngue                       | 13 s         | 2,7 GB  | 6,1%³                                    | 2,2 GB   | MIT        |

¹ A frase inteira: o Supertonic gera tudo de uma vez, cerca de 100 vezes mais
rápido que o tempo de fala.
² O PocketTTS entrega quadros de 80 ms enquanto gera (3 a 4 vezes mais rápido
que o tempo de fala).
³ Só nas 4 respostas de `frases-faladas.txt` (66 palavras): lentos demais para
as 100 frases, e já descartados pelo tempo e pela memória.

**Erro ao transcrever** é o WER quando o Parakeet Ultra (o reconhecedor do
app) transcreve o áudio de volta, com a mesma normalização do `bench/stt`. Mede
se as palavras saem certas, **não** se a voz soa natural ou agradável: isso
só ouvindo.

**Normalizar o texto antes de falar ajuda as vozes neurais.** Com dígitos e
símbolos, o PocketTTS leu "20 mil" como "2 mil" nas três vozes e pulou o trecho
depois de ";". Por isso o app passa cada frase por `spokenText()`
(`packages/desktop/src/main/spoken.ts`): números por extenso, "%" como "por
cento", ";" como vírgula, sem markdown. Nas 4 respostas, o erro caiu de 15,2% para
9,1% no Supertonic F1 e de 12,1% para 9,1% no PocketTTS alba. A voz do macOS
não muda: ela já lê números.

## Escolha

- **Padrão: a voz do macOS**, até a escolha de ouvido. Não baixa nada, é
  instantânea e erra menos, mas é a mais robótica.
- **Recomendada entre as neurais: Supertonic 3.** Erra quase igual à do macOS,
  usa um sexto da memória do PocketTTS e a frase sai em menos de 0,1 s. Fala mais
  devagar: as mesmas respostas duram cerca de 10% a mais que na voz do macOS e
  50% a mais que no PocketTTS.
- **PocketTTS** fica como opção: começa a tocar mais cedo, mas erra mais (pula
  palavras, às vezes a primeira) e usa cerca de 740 MB.
- **Descartadas:** Chatterbox (13 s por frase) e PocketTTS de 24 camadas (1,8 GB
  e quase 1 s até o primeiro som).
- **Kokoro** não entrou: o FluidAudio não tem a variante em português, e as
  vozes `pf_*`/`pm_*` falariam com a fonética do inglês.

As vozes premium e aprimoradas do macOS (Luciana aprimorada, Felipe) não estavam
instaladas e não foram medidas. Quem baixar uma em Ajustes do Sistema →
Acessibilidade → Conteúdo Falado → Vozes do Sistema passa a ouvi-la na opção
"macOS": o `voz` usa a melhor voz pt-BR instalada.

## Ouvir

Depois de `./run.sh` e `node report.mjs`, `audio/ouvir/<voz>.wav` tem as quatro
respostas de `frases-faladas.txt` em sequência (com 0,6 s de pausa entre elas), e
`audio/<voz>/` tem cada frase separada.

## Limitações

- **Inteligibilidade medida por máquina:** o Parakeet foi avaliado com a voz
  Luciana no `bench/stt` e pode entender melhor vozes parecidas com ela.
- **Amostragem aleatória:** o PocketTTS sorteia (temperatura 0,7), então duas
  rodadas do mesmo texto erram em lugares diferentes.
- **Termos em inglês** ("roadmap", "back-end") saem errados em quase todas as
  vozes neurais.
- **Naturalidade:** não medida. Falta ouvir e escolher.

## Reproduzir

```bash
(cd engines/fluid && swift build -c release)    # FluidAudio no mesmo commit do native/voz
./run.sh                                        # frases.txt, todas as vozes (baixa os modelos em models/)
TEXT=frases-faladas.txt ./run.sh                # as mesmas frases depois de spokenText()
node fleurs.mjs && TEXT=fleurs.txt ./run.sh apple:Luciana supertonic:M1 supertonic:F1 pocket:alba pocket:vera pocket:rafael
node report.mjs                                 # precisa de bench/stt/bin/parakeet e do modelo Ultra
```

Resultados: `results/summary.json` (cada frase, com o que o Parakeet ouviu) e
`results/raw/`. O FLEURS (Google, CC BY 4.0) vem das referências já salvas em
`bench/stt/results/raw`.
