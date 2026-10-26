# Arquitetura

```
┌──────────────────────── app (Electron, barra de menus) ────────────────────────┐
│  painel (renderer)  ⇄  IPC validado (zod)  ⇄  processo principal               │
│                                                │                               │
│                       núcleo (packages/core)   │   voz (native/voz, Swift)     │
│                       rota, estimativa, limite │   microfone → fim da fala →   │
│                       confirmações             │   Parakeet → texto            │
│                                │               │   texto → voz (macOS/neural)  │
└────────────────────────────────┼───────────────┴───────────────────────────────┘
                                 │ motor (packages/engines)
                                 ▼
                     claude -p  (o Claude Code da pessoa, login dela)
                        │                         │
              servidor MCP do ANI-9      servidor MCP do app (packages/app-mcp)
              (packages/ani-mcp)         aprovar · confirmar_plano
                        │                         │ socket privado
                        ▼                         ▼
                 API do ANI-9 (token)      o app pergunta à pessoa
```

## Pacotes

| Pacote             | O que faz                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `packages/ani-mcp` | O ANI-9 como servidor MCP (stdio): leitura e escritas confirmadas. Usável sozinho no Claude Code. |
| `packages/engines` | A interface de motor e o adaptador do Claude Code (processo por pedido ou sessão viva).           |
| `packages/app-mcp` | Aprovação de ações e de planos: o motor pergunta, o app responde com a decisão da pessoa.         |
| `packages/core`    | A conversa: modelo por tipo de pedido, estimativa e limite de tokens, frases de confirmação.      |
| `packages/cli`     | Conversa pelo terminal com o mesmo núcleo (testes de ponta a ponta).                              |
| `packages/desktop` | O app de barra de menus: painel, atalho global, voz, ajustes.                                     |
| `native/voz`       | Ouvir e falar, num processo nativo.                                                               |
| `bench/stt`        | Comparação de reconhecimento de fala em pt-BR que escolheu o motor de `voz`.                      |
| `bench/tts`        | Comparação das vozes que respondem (macOS, Supertonic 3, PocketTTS…) em pt-BR.                    |

## Um pedido, do atalho à resposta

1. **⌥Espaço:** o app abre o painel, aquece o motor (abre o processo do Claude
   Code; nada é enviado) e manda `voz` ouvir.
2. **`voz`:** detecta o início e o fim da fala (600 ms de silêncio), transcreve
   com o Parakeet e devolve o texto.
3. **Núcleo:** decide o tipo (rápido ou tarefa) e o modelo, e envia o pedido à
   sessão viva.
4. **Motor:** chama as ferramentas do ANI-9. As de leitura rodam direto;
   qualquer outra passa pela aprovação, e o app pergunta por voz e no painel.
   A primeira resposta, falada ou clicada, vale.
5. **Tarefa longa:** o modelo chama `confirmar_plano`; o app estima os tokens
   pelo histórico e diz quanto da janela de 5 horas já foi usado. Se a
   execução passar do limite, o app para e pergunta se continua.
6. **Resposta:** aparece no painel e é falada frase por frase, na voz escolhida
   em Ajustes, depois de virar texto falável (números por extenso).

## Privacidade

- O áudio fica no processo `voz`: não é gravado em disco nem enviado.
- O token do ANI-9 fica cifrado com a chave das Chaves do macOS
  (`safeStorage`). A configuração MCP de cada sessão, que o contém, fica numa
  pasta temporária 0700, com o arquivo 0600, e é apagada ao fechar.
- O histórico local guarda só contagens (tipo, modelo, passos, tokens), nunca
  o conteúdo dos pedidos.
- Credenciais do Claude nunca são lidas: o status vem de
  `claude auth status`, e o login é o do próprio Claude Code.
