import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CatalogError, createCatalog, type Catalog, type CatalogOptions } from "./catalog.js";

export const SERVER_NAME = "roadmaps";
export const SERVER_VERSION = "0.1.0";

/**
 * Tools an app may run without asking: reading the catalog, and saving a draft
 * in the local clone (nothing leaves the computer). Opening the pull request
 * publishes, so it always goes through the person.
 */
export const ROADMAP_READ_TOOLS = ["roadmap_preparar", "roadmap_ler", "roadmap_salvar_e_validar"] as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function respond(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await work() }] };
  } catch (error) {
    const known = error instanceof CatalogError;
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: known ? `${message} Não adianta repetir sem mudar algo.` : `Erro inesperado: ${message}`,
        },
      ],
    };
  }
}

/** The public roadmap catalog as MCP tools: its rules, a draft validated by its own script, and the pull request. */
export function createRoadmapsMcpServer(options: { catalog: Catalog } | CatalogOptions): McpServer {
  const catalog = "catalog" in options ? options.catalog : createCatalog(options);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "roadmap_preparar",
    {
      title: "Preparar o catálogo de roadmaps",
      description:
        "Baixa ou atualiza o catálogo público de roadmaps do ANI-9 e devolve as regras atuais (a skill criar-roadmap, " +
        "como escolher fontes, a revisão final e o formato) e a lista de roadmaps que já existem. Chame antes de criar " +
        "ou revisar um roadmap e siga as regras devolvidas.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      respond(async () => {
        const { rules, models } = await catalog.prepare();
        const existing = models.length
          ? models
              .map(
                (m) =>
                  `- ${m.key}: ${m.title} (formato ${m.version}; ${m.topics} tópicos, ${m.cards} cartões, ${m.sources} fontes)`,
              )
              .join("\n")
          : "(nenhum)";
        return `Roadmaps no catálogo:\n${existing}\n\nRegras do catálogo:\n\n${rules}`;
      }),
  );

  server.registerTool(
    "roadmap_ler",
    {
      title: "Ler um roadmap do catálogo",
      description: "Devolve o JSON de um roadmap do catálogo, pela chave (como back-end-go), para revisar ou melhorar.",
      inputSchema: { chave: z.string().describe("A chave do roadmap: o nome do arquivo sem .json.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ chave }) => respond(async () => catalog.read(chave)),
  );

  server.registerTool(
    "roadmap_salvar_e_validar",
    {
      title: "Salvar e validar um roadmap",
      description:
        "Grava o roadmap em models/<chave>.json na cópia local do catálogo (num branch roadmap/<chave>; nada é publicado) " +
        "e roda o validador do catálogo, abrindo cada link. Devolve primeiro os ERROS e AVISOS e depois, para cada fonte, " +
        'o nome dado e o título real da página (TÍTULO). Corrija e chame de novo até "Sem erros."; troque as fontes ' +
        "cuja página não trata do cartão.",
      inputSchema: {
        chave: z.string().describe("Slug do tema: a-z, 0-9 e hífen, como back-end-node."),
        roadmap: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe("O roadmap inteiro, no formato 2 do catálogo."),
        titulos: z.boolean().optional().describe("Mostrar o título real de cada página (padrão: sim)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ chave, roadmap, titulos }) =>
      respond(async () => {
        const { ok, report } = await catalog.saveAndValidate(chave, roadmap, titulos ?? true);
        return `${ok ? "Válido." : "Ainda com erros."}\n\n${report}`;
      }),
  );

  server.registerTool(
    "roadmap_abrir_pr",
    {
      title: "Abrir o pull request do roadmap",
      description:
        "Publica: faz o commit do roadmap já validado (e da linha no README, se for novo) e abre um pull request no " +
        "catálogo público com o gh da pessoa; sem permissão de escrita, pelo fork dela. Só chame depois de a pessoa " +
        "confirmar. Devolve o link do pull request.",
      inputSchema: {
        chave: z.string(),
        titulo: z.string().optional().describe("Título do pull request (padrão: Roadmap: <título>)."),
        descricao: z.string().optional().describe("Descrição do pull request (padrão: um resumo com os números)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ chave, titulo, descricao }) =>
      respond(async () => {
        const { url, viaFork } = await catalog.openPullRequest(chave, { title: titulo, body: descricao });
        return `Pull request aberto${viaFork ? " (pelo seu fork)" : ""}: ${url}\nO merge fica com quem mantém o catálogo; depois, o app traz o roadmap numa atualização.`;
      }),
  );

  return server;
}
