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

## Voz (a medir)

A base de comparação é o [spokemark](https://github.com/VitoorFranca/spokemark),
que mediu motores de reconhecimento no mesmo Mac. O padrão dele (Parakeet
Nemotron Streaming) só reconhece inglês. O assistente recebe comandos curtos em
português e precisa acertar o pedido depois que a pessoa para de falar, então
modelos que transcrevem a frase inteira de uma vez, descartados lá, voltam a
concorrer aqui:

- Parakeet TDT v3 (multilíngue, pelo FluidAudio);
- Apple SpeechAnalyzer (sem download; conferir pt-BR em `supportedLocales`);
- Whisper large-v3-turbo.

A escolha sai de medições em pt-BR: erro por palavra, tempo entre o fim da
fala e o texto pronto, memória e CPU/GPU. A voz falada passa pelo mesmo
processo (Kokoro e PocketTTS do FluidAudio, Piper, vozes do macOS).
