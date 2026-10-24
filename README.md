# ani-assistente

Assistente de voz **open source** para estudar com o [ANI-9](https://www.ani9.online),
no Mac. Você fala, ele responde com voz própria e age no ANI-9: diz o que tem
para revisar, lê estatísticas, cria cartões, cadernos e anotações, lê roadmaps
e cuida das suas tarefas.

O assistente **não tem custo de IA próprio**: cada pessoa usa a **própria**
assinatura ou chave, num motor de IA que ela mesma instalou e em que ela mesma
fez login. O primeiro motor é o Claude Code; outros entram como adaptadores.

> **Estado:** em construção. Hoje funciona o servidor MCP do ANI-9
> ([`packages/ani-mcp`](packages/ani-mcp)), que já dá para usar no seu
> Claude Code. O app de voz vem a seguir. Veja o [plano](#plano).

## Como funciona

```
 atalho / "Ei, Ani"  →  ouvir (local)  →  motor de IA  →  falar (local)
                                              │
                               ferramentas do ANI-9 (servidor MCP)
```

- **Voz local:** reconhecimento e síntese de fala rodam no seu Mac. O áudio não
  sai da máquina.
- **Motor de IA trocável:** cada motor é um adaptador com a mesma interface:
  status, login (pelo fluxo do próprio fornecedor), executar e devolver eventos.
- **Ferramentas do ANI-9 num servidor MCP:** escritas uma vez, funcionam em
  qualquer motor que fale MCP.
- **Sua conta do ANI-9:** um token pessoal, gerado em Configurações →
  Integrações. O app nunca pede a sua senha.

Detalhes e medições: [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Usar o servidor MCP do ANI-9 no seu Claude Code

1. No ANI-9, gere um token em **Configurações → Integrações → Tokens de acesso**.
2. Compile o servidor:
   ```bash
   pnpm install && pnpm -C packages/ani-mcp build
   ```
3. Adicione-o ao Claude Code (o token fica só na sua máquina):
   ```bash
   claude mcp add ani9 --env ANI_TOKEN=ani9_SEU_TOKEN -- node "$PWD/packages/ani-mcp/dist/index.js"
   ```
4. Pergunte: _"Quantas revisões eu tenho hoje no ANI-9?"_

Ferramentas: resumo do dia, estatísticas, baralhos, busca de cartões, criar
cartão, cadernos e folhas (ler, criar, anotar), roadmaps (ler, marcar
progresso) e tarefas (listar, adicionar, concluir). As que mudam dados avisam
o motor para confirmar com você antes.

## Regras deste projeto sobre assinaturas

O projeto segue os [termos do Claude Code](https://code.claude.com/docs/en/legal-and-compliance):

- O app **chama o `claude` oficial que você instalou**, sem modificá-lo, sem
  embuti-lo e sem remover nenhuma forma de login.
- O app **nunca lê, guarda nem repassa credenciais** do Claude (arquivos de
  login, tokens de sessão). O login é feito por você, no próprio Claude Code.
- O uso é **seu, na sua assinatura**: o projeto não paga, revende nem
  intermedeia uso de IA de ninguém.
- O nome e o logo do projeto **não usam "Claude"**. Dá para dizer, em texto
  simples, que ele funciona com o Claude Code.

Contribuições que quebrem essas regras não são aceitas. Para outros motores,
valem os termos de cada fornecedor, conferidos antes de o adaptador entrar.

## Plano

1. ✅ Tokens de acesso pessoais no ANI-9.
2. ✅ Servidor MCP do ANI-9.
3. Núcleo do app: interface de motor, adaptador do Claude Code, escolha de
   modelo, estimativa de tokens com confirmação, conversa por texto.
4. Voz: escolha do modelo de fala por comparação em pt-BR, atalho global,
   síntese de voz; depois, "Ei, Ani".
5. Outros motores (chave de API; Cursor, depois de conferir os termos dele).

## Licença

[MIT](LICENSE).
