# Decisões técnicas

Cada decisão diz o que foi escolhido, o que foi descartado e por quê. O que foi
medido diz onde e como; o que não foi medido está marcado.

## Motor de IA: o CLI oficial, não o Agent SDK

**Escolhido:** chamar o `claude` instalado pela pessoa, em modo não interativo
(`claude -p … --output-format json|stream-json`), como processo filho.

- Os [termos do Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
  não permitem que apps de terceiros ofereçam o login do claude.ai nem mandem
  pedidos com credenciais de assinatura em nome das pessoas, inclusive pelo
  Agent SDK. Eles não impedem a pessoa de entrar no Claude Code oficial, sem
  modificação, com a própria assinatura. O app só executa esse binário.
- O app não toca em credenciais e não usa `--bare`, que ignora o login da
  assinatura e exige chave de API.

**Descartado:** Agent SDK com a assinatura (proibido pelos termos acima) e
chave de API como padrão (cada pessoa pagaria duas vezes; vira um adaptador
opcional).

### Contexto enxuto

Medido em 24/10/2026 (Claude Code 2.1.300, modelo `haiku`, MacBook Air M4),
mesma pergunta ("Quantas revisões eu tenho hoje?"), servidor MCP do ANI-9 local:

| Configuração                                                               | Tempo     | Tokens de entrada | Saída |
| -------------------------------------------------------------------------- | --------- | ----------------- | ----- |
| Padrão (`--mcp-config --strict-mcp-config --allowedTools`)                 | 6,4 s     | 57.759            | 306   |
| Enxuta (+ `--system-prompt` próprio, `--tools ""`, `--setting-sources ""`) | **1,5 s** | **8.926**         | 70    |

As duas respostas estavam corretas. O prompt de sistema padrão do Claude Code
e as ferramentas de programação são quase todo o contexto; um assistente de
estudo não precisa deles. A configuração enxuta é o padrão do adaptador.

Medição única, sem repetição; serve para a ordem de grandeza.

## Confirmação antes de mudar dados: por código, não por instrução

**Escolhido:** a ferramenta de aprovação do próprio Claude Code
(`--permission-prompt-tool`). Só as ferramentas de leitura do ANI-9 rodam
sem perguntar (`--allowedTools`); qualquer outra chamada vai para
`mcp__app__aprovar`, um servidor MCP pequeno (`packages/app-mcp`) que pergunta
ao app e devolve a decisão da pessoa.

- Contrato verificado em 24/10/2026 (Claude Code 2.1.300): a ferramenta
  recebe `{ tool_name, input, tool_use_id }` e responde
  `{ "behavior": "allow", "updatedInput" }` ou
  `{ "behavior": "deny", "message" }`. Com "deny", nada mudou no ANI-9; com
  "allow", a tarefa foi criada.
- Uma instrução no prompt ("pergunte antes de criar") falha de vez em quando;
  a aprovação por código não deixa a ação passar sem resposta.
- O servidor de aprovação fala com o app por um socket Unix numa pasta 0700,
  com um segredo por sessão. Se o app não responde, a resposta é "recusar".
- Tarefas longas: o modelo chama `confirmar_plano` com os passos; o app
  calcula a estimativa e pergunta. Como reforço, cada execução tem um limite
  de tokens: ao passar dele, o app para e pergunta se continua (a mesma
  sessão é retomada).

## Limites da assinatura

A saída do `claude -p` traz um evento `rate_limit_event` com a fração usada
das janelas de 5 horas e da semana e quando elas recomeçam. O assistente usa
isso para dizer "você já usou 30% da janela de 5 horas" junto da estimativa.

## Teste de ponta a ponta (terminal)

`packages/cli` usa o mesmo núcleo do app, sem voz. Medido em 24/10/2026
contra o ANI-9 local, Claude Code 2.1.300, assinatura Pro:

| Fala                                                | Modelo  | Ferramenta             | Tempo     | Tokens  |
| --------------------------------------------------- | ------- | ---------------------- | --------- | ------- |
| "Quantas revisões eu tenho hoje?"                   | haiku   | `ani_resumo_do_dia`    | 2,9–6,3 s | ~10 mil |
| "Anota a tarefa de revisar o caderno…" (confirmada) | sonnet* | `ani_adicionar_tarefa` | 3,5 s     | ~11 mil |
| "Quais tarefas estão abertas?"                      | haiku   | `ani_listar_tarefas`   | 3,7 s     | ~11 mil |

\* Corrigido depois: ações únicas ("anota", "marca", "cria um cartão") vão
para o modelo rápido.

A conversa continua entre falas (`--resume`), mesmo trocando de modelo. A
maior parte do tempo é partida: cada fala inicia o Claude Code e os dois
servidores MCP. Próximo passo: manter um processo vivo entre falas
(`--input-format stream-json`) e medir de novo.

## Ferramentas do ANI-9: servidor MCP local (stdio)

**Escolhido:** `packages/ani-mcp`, um servidor MCP que o motor inicia e com
que conversa por stdio. Fala com a API do ANI-9 usando um token de acesso
pessoal.

- Qualquer motor que fale MCP usa as mesmas ferramentas (Claude Code, Cursor e
  outros), e a pessoa pode usá-lo no próprio Claude Code, sem o app.
- Descartado: um comando de terminal chamado pelo Bash do motor (exige liberar
  o Bash; respostas sem estrutura) e ferramentas embutidas num SDK (presas a um
  motor).
- Para depois: um servidor MCP remoto dentro do ANI-9, que também funcionaria
  como conector no claude.ai e no celular, mas exige OAuth no ANI-9.

### Como as ferramentas foram escritas

- **Respostas em texto curto**, prontas para falar e baratas em contexto.
  Listas vêm cortadas e textos longos, aparados.
- **Nunca adivinhar:** um nome que não bate com nada, ou bate com mais de uma
  coisa, volta como pergunta ("Há mais de um caderno parecido com…"). Nomes
  repetidos aparecem com o começo do id, que também serve para escolher.
- **Escritas marcadas:** as ferramentas que mudam dados têm
  `readOnlyHint: false` e dizem na descrição que o motor deve confirmar com a
  pessoa. Um teste garante que nenhuma escrita fica sem esse aviso.
- **Erros que orientam:** cada erro diz o tipo (autenticação, não encontrado,
  pedido inválido, indisponível) e se adianta tentar de novo.
- **Tarefas sem mudar o ANI-9:** ficam numa folha "Tarefas" de um caderno
  "Tarefas", uma por parágrafo (☐ aberta, ☑ concluída). A conclusão compara o
  texto de cada parágrafo, não o HTML, porque o ANI-9 limpa e recodifica o
  HTML das folhas ao salvar.

Achados no teste de ponta a ponta contra o ANI-9 local, que o teste com
cliente falso não pegava: o `POST` de folha devolve a folha sem envelope, e
três cadernos com o mesmo nome geravam uma pergunta sem como responder.
Corrigidos e cobertos por testes.

## Conta do ANI-9: tokens de acesso pessoais

Implementados no ANI-9 para este projeto:

- `ani9_` + 32 bytes aleatórios; o servidor guarda só o SHA-256.
- Enviado como `Authorization: Bearer`. Vale só para a conta dona, pode ser
  revogado a qualquer momento e nunca gerencia outros tokens.
- O app guarda o token nas Chaves do macOS (fase 3).

## Voz: Parakeet Ultra, num processo nativo

**Escolhido:** `native/voz`, um executável Swift com o FluidAudio (Apache-2.0,
mesmo commit do spokemark): microfone (AVAudioEngine) → Silero VAD (fim da
fala com 600 ms de silêncio) → **Parakeet Ultra** → texto. A resposta sai pela
voz escolhida em Ajustes (veja "Voz da Ani").

Comparação completa em [`bench/stt`](../bench/stt/README.md). Resumo (MacBook
Air M4, FLEURS pt_br com 100 frases e 24 comandos):

| Motor                  | Erro FLEURS | Erro comandos | Tempo por frase |
| ---------------------- | ----------- | ------------- | --------------- |
| Parakeet Ultra         | 4,4%        | 3,4%          | 63 ms           |
| Whisper large-v3-turbo | 3,6%        | 2,2%          | 1,9 s           |
| Apple SpeechAnalyzer   | 5,9%        | 10,6%         | 93 ms           |

- O Whisper turbo erra cerca de 1 ponto a menos, mas é 30 vezes mais lento e
  usa GPU e até 1,9 GB. No assistente, a espera depois de falar pesa mais.
- O padrão do spokemark (Nemotron Streaming) só reconhece inglês; o Parakeet
  TDT, descartado lá por ser em bloco, é o certo aqui: o assistente
  transcreve a frase inteira depois do fim da fala.
- Medido no próprio `voz` (arquivo no ritmo real, mesmo caminho do
  microfone): 120–132 ms entre o fim da fala e o texto.
- Ponto fraco: termos em inglês ("back-end com Go"). A testar: vocabulário
  personalizado do FluidAudio.
- A voz própria (Kokoro, PocketTTS) entra depois de medir naturalidade em
  pt-BR; o README do FluidAudio é contraditório sobre o suporte a português.

## "Ei, Ani": o próprio reconhecimento de fala, sem detector pago

**Escolhido:** no modo de ativação, o `voz` separa trechos curtos de fala
(Silero, até 5 s) e transcreve cada um com o Parakeet; o app aceita o trecho
só se ele começar com a palavra de ativação e descarta o resto na hora, sem
guardar nem mostrar.

- O Parakeet escreve "Ei, Ani" de vários jeitos ("Eiane", "Oiane", "Ani,").
  A regra junta as duas primeiras palavras e aceita uma saudação opcional
  mais "Ani" ("ani", "ane", "annie"). Testada com transcrições reais; "Ana",
  "Anime", "Ei, Antônio" e frases comuns não ativam. "Ei ole ni" (uma das
  transcrições) não ativa: prefere-se repetir a ativar sozinho.
- Se o pedido vier junto ("Ei, Ani, quantas revisões…"), ele vai direto.
- Desligado por padrão: o microfone fica aberto o tempo todo enquanto ligado
  (nada sai do Mac). A escuta pausa enquanto a Ani ouve um pedido, responde ou
  pergunta, para não ouvir a si mesma.
- Descartados: Porcupine (exige chave da Picovoice), openWakeWord (ONNX em
  Python, novo runtime) e o vocabulário personalizado do FluidAudio (a
  avaliar para melhorar a ativação e os termos em inglês).

## Fala por frases

A resposta é dividida em frases enquanto chega, e cada frase vai para a
síntese de voz assim que termina (a síntese enfileira). Frases muito curtas
("Pronto.") esperam a seguinte; decimais ("3.5") não cortam. Com isso, a voz
começa ao fim da primeira frase, não da resposta inteira.

## Voz da Ani: macOS por padrão, Supertonic 3 como voz neural

Comparação em [`bench/tts`](../bench/tts/README.md) (MacBook Air M4). Cada voz
leu as mesmas frases, e o Parakeet transcreveu o áudio de volta para medir se
as palavras saem certas:

| Voz                      | Primeiro som | Memória | Erro (FLEURS, 100 frases) |
| ------------------------ | ------------ | ------- | ------------------------- |
| macOS Luciana            | 8 ms         | 55 MB   | 6,0%                      |
| Supertonic 3             | 95 ms        | 115 MB  | 6,9–7,0%                  |
| PocketTTS pt (6 camadas) | 50–66 ms     | 740 MB  | 9,3–9,9%                  |

- O app oferece as três em Ajustes. O padrão continua sendo a voz do macOS
  (sem download, instantânea), até alguém ouvir e escolher: naturalidade não
  se mede por transcrição.
- O Supertonic é a voz neural recomendada: erra quase igual à do macOS e usa
  um sexto da memória do PocketTTS. O PocketTTS fica como opção.
- Chatterbox (13 s por frase, 2,7 GB) e PocketTTS de 24 camadas (1,8 GB) foram
  descartados. O Kokoro não tem português no FluidAudio.
- Antes de falar, cada frase passa por `spokenText()`: números por extenso,
  "%" como "por cento", ";" como vírgula. Sem isso, o PocketTTS leu "20 mil"
  como "2 mil".
- As vozes neurais tocam pelo AVAudioEngine dentro do `voz`, uma frase por vez
  (a seguinte é gerada enquanto a atual toca). Se a voz escolhida não carregar,
  o `voz` avisa e usa a do macOS.
- Os modelos são baixados do Hugging Face na primeira vez e não vão no app:
  Supertonic 3 (Supertone, OpenRAIL-M, com restrições de uso) e PocketTTS
  (Kyutai, CC BY 4.0).

## Sessão viva: o motor aquece enquanto a pessoa fala

O `claude -p` com `--input-format stream-json` fica aberto e recebe um pedido
por linha. Medido em 24/10/2026 (haiku, servidor MCP do ANI-9 local):

|                                          | Um processo por pedido | Sessão viva |
| ---------------------------------------- | ---------------------- | ----------- |
| Primeiro pedido (inclui ~1 s de partida) | 2,9–5,4 s              | 3,8 s       |
| Pedido seguinte com consulta ao ANI-9    | 2,9–5,4 s              | 2,5 s       |
| Pedido sem consulta                      | —                      | 1,4 s       |

O app abre a sessão quando o painel abre ou o atalho é pressionado; abrir
não envia nada ao modelo. Interromper um pedido encerra o processo; o
próximo pedido retoma a mesma conversa (`--resume`) num processo novo.
Trocar de modelo também abre outro processo, retomando a conversa.

## App: Electron na barra de menus

Mesmas escolhas do spokemark, já validadas no mesmo Mac: Electron 44,
esbuild, IPC validado com zod nos dois lados, painel `type: "panel"`. O
painel é TypeScript sem framework (é pequeno; menos dependências). O token do
ANI-9 fica cifrado com `safeStorage` (chave nas Chaves do macOS). Os dois
servidores MCP vão empacotados num arquivo cada e rodam com o próprio
Electron em modo Node (`ELECTRON_RUN_AS_NODE`).

Teste de ponta a ponta (Playwright para Electron, ANI-9 local): configuração,
token, pergunta, pedido com confirmação ("Anotar a tarefa …?" → Sim → tarefa
criada), ajustes. Sem erros. O microfone não foi exercitado no teste
automático (exige a permissão do macOS e uma pessoa falando).

## Roadmaps do catálogo pelo assistente

Pedidos como "cria um roadmap de química" vão para uma rota própria
(`roadmap`), com conversa separada das outras:

- **Regras num lugar só.** O servidor `roadmaps` clona o catálogo público e
  devolve a skill `criar-roadmap`, as referências e o formato que estão lá. O
  assistente não tem uma cópia das regras: melhorou a skill, melhorou o
  assistente.
- **Pesquisa só onde precisa.** WebSearch e WebFetch (ferramentas do próprio
  Claude Code) só entram nessa rota; os pedidos do dia a dia continuam com o
  contexto enxuto.
- **Validação pelo script do catálogo**, com o título real de cada página ao
  lado do nome da fonte, até "Sem erros.".
- **Publicar sempre pergunta.** Ler, rascunhar e validar rodam direto (nada sai
  do computador); `roadmap_abrir_pr` passa pela confirmação. O pull request usa
  o `gh` da pessoa (o git pede a credencial ao gh só naquele comando; nenhuma
  configuração global muda) e, sem permissão de escrita, vai por um fork.
- **Orçamento maior** (800 mil tokens por padrão) e estimativa por passo
  própria (40 a 120 mil), porque cada passo abre muitas páginas. O plano é
  confirmado antes de começar.
