# App de barra de menus

```bash
pnpm -C packages/desktop start     # desenvolvimento
pnpm -C packages/desktop package   # release/Ani-darwin-arm64/Ani.app e um zip
```

O app procura o `claude` pelo shell de login (`$SHELL -l -c 'command -v claude'`),
depois em `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` e
`/usr/local/bin`. `ANI_CLAUDE_PATH` força um caminho.

## Variáveis para testes e desenvolvimento

Nunca usadas no uso normal.

| Variável                        | Efeito                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- |
| `ANI_ASSISTENTE_DATA`           | Pasta de dados própria (configurações, token, histórico, modelos de voz). |
| `ANI_ASSISTENTE_MUTE=1`         | A voz não toca som: cada frase conta como falada na hora.                 |
| `ANI_ASSISTENTE_TEST_WAKE_FILE` | O modo "Ei, Ani" lê este WAV em vez do microfone.                         |

Os testes de ponta a ponta (Playwright para Electron) usam as três, contra o
ANI-9 local, sem microfone e sem som.
