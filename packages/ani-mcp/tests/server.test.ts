import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AniError, type AniClient } from "../src/client.js";
import { createAniMcpServer } from "../src/server.js";

async function connect(client: AniClient) {
  const server = createAniMcpServer({ client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "teste", version: "0" });
  await mcp.connect(clientSide);
  return mcp;
}

const unreachable: AniClient = {
  get: async () => {
    throw new AniError("Não consegui falar com o ANI-9 (sem conexão?).", "unavailable", true);
  },
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  put: async () => ({}) as never,
};

describe("MCP server", () => {
  it("lists every tool, marking which ones change data", async () => {
    const mcp = await connect(unreachable);
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ani_adicionar_tarefa",
      "ani_anotar_na_folha",
      "ani_buscar_cartoes",
      "ani_concluir_tarefa",
      "ani_conta",
      "ani_criar_caderno",
      "ani_criar_folha",
      "ani_criar_nota",
      "ani_estatisticas",
      "ani_ler_caderno",
      "ani_ler_folha",
      "ani_ler_roadmap",
      "ani_listar_baralhos",
      "ani_listar_cadernos",
      "ani_listar_roadmaps",
      "ani_listar_tarefas",
      "ani_marcar_progresso_roadmap",
      "ani_resumo_do_dia",
    ]);
    for (const tool of tools) {
      const writes = tool.annotations?.readOnlyHint === false;
      expect(tool.description!.includes("confirme com a pessoa"), tool.name).toBe(writes);
    }
  });

  it("reports failures as tool errors that say whether to retry", async () => {
    const mcp = await connect(unreachable);
    const result = await mcp.callTool({ name: "ani_resumo_do_dia", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toBe(
      "Erro (unavailable): Não consegui falar com o ANI-9 (sem conexão?). Pode tentar de novo.",
    );
  });

  it("validates arguments before reaching the ANI-9", async () => {
    const mcp = await connect(unreachable);
    const result = await mcp.callTool({ name: "ani_buscar_cartoes", arguments: { busca: "", limite: 50 } });
    expect(result.isError).toBe(true);
  });
});
