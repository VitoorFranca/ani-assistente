import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AniError, createAniClient, type AniClient } from "./client.js";
import { createOperations, ResolutionError } from "./operations.js";

export const SERVER_NAME = "ani9";
export const SERVER_VERSION = "0.1.0";

const WRITES = "Muda dados no ANI-9: confirme com a pessoa antes de chamar.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Every answer is text; failures say whether a retry makes sense or the person must decide. */
async function respond(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await work() }] };
  } catch (error) {
    if (error instanceof ResolutionError) {
      return { isError: true, content: [{ type: "text", text: `Precisa de esclarecimento: ${error.message}` }] };
    }
    if (error instanceof AniError) {
      const hint = error.retryable ? "Pode tentar de novo." : "Não adianta repetir: avise a pessoa.";
      return { isError: true, content: [{ type: "text", text: `Erro (${error.kind}): ${error.message} ${hint}` }] };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Erro inesperado: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
}

/** The ANI-9 as MCP tools: reading the day, decks, cards, notebooks and roadmaps; a few careful writes. */
export function createAniMcpServer(options: { client: AniClient } | { baseUrl: string; token: string }): McpServer {
  const client = "client" in options ? options.client : createAniClient(options);
  const ops = createOperations(client);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    "ani_conta",
    {
      title: "Conta do ANI-9",
      description: "Diz com qual conta do ANI-9 o assistente está conectado. Use para checar a conexão.",
      annotations: read,
    },
    () => respond(ops.account),
  );

  server.registerTool(
    "ani_resumo_do_dia",
    {
      title: "Resumo do dia",
      description:
        "Resumo do estudo de hoje: revisões pendentes (e atrasadas), revisões já feitas, sequência de dias, cartões novos e os baralhos com mais revisões. Use para 'o que tenho hoje?', 'como estou?'.",
      annotations: read,
    },
    () => respond(ops.today),
  );

  server.registerTool(
    "ani_estatisticas",
    {
      title: "Estatísticas",
      description:
        "Totais de cartões por estado, retenção e revisões previstas nas próximas semanas. Para o dia de hoje, prefira ani_resumo_do_dia.",
      annotations: read,
    },
    () => respond(ops.statistics),
  );

  server.registerTool(
    "ani_listar_baralhos",
    {
      title: "Listar baralhos",
      description:
        "Lista os baralhos com revisões pendentes, cartões novos e total. Subbaralhos aparecem como Pai::Filho.",
      inputSchema: { incluirArquivados: z.boolean().optional().describe("Incluir baralhos arquivados. Padrão: não.") },
      annotations: read,
    },
    ({ incluirArquivados }) => respond(() => ops.listDecks(incluirArquivados ?? false)),
  );

  server.registerTool(
    "ani_buscar_cartoes",
    {
      title: "Buscar cartões",
      description:
        "Busca cartões por texto e mostra frente → verso. Aceita a busca do ANI-9: palavras, deck:nome, tag:nome, is:due (para revisar), is:new. Use para responder sobre o conteúdo que a pessoa já estudou.",
      inputSchema: {
        busca: z.string().min(1).describe('Ex.: "mitocôndria", "deck:Fisiologia is:due".'),
        limite: z.number().int().min(1).max(20).optional().describe("Quantos mostrar (1–20, padrão 10)."),
      },
      annotations: read,
    },
    ({ busca, limite }) => respond(() => ops.searchCards(busca, limite ?? 10)),
  );

  server.registerTool(
    "ani_criar_nota",
    {
      title: "Criar cartão",
      description: `Cria um cartão (frente e verso, tipo Básico) num baralho existente, pelo nome ou id. ${WRITES} Se o baralho for ambíguo, pergunte qual.`,
      inputSchema: {
        baralho: z.string().min(1).describe('Nome do baralho (ex.: "Fisiologia" ou "Medicina::Fisiologia") ou id.'),
        frente: z.string().min(1).describe("A pergunta."),
        verso: z.string().min(1).describe("A resposta."),
      },
      annotations: write,
    },
    ({ baralho, frente, verso }) => respond(() => ops.createNote({ deck: baralho, front: frente, back: verso })),
  );

  server.registerTool(
    "ani_listar_cadernos",
    {
      title: "Listar cadernos",
      description: "Lista os cadernos (material de estudo) com o número de folhas e as tags.",
      annotations: read,
    },
    () => respond(ops.listNotebooks),
  );

  server.registerTool(
    "ani_ler_caderno",
    {
      title: "Ler caderno",
      description:
        "Lista as folhas de um caderno, com o id de cada uma (para ler ou anotar). Aceita o nome ou o id do caderno.",
      inputSchema: { caderno: z.string().min(1).describe("Nome ou id do caderno.") },
      annotations: read,
    },
    ({ caderno }) => respond(() => ops.readNotebook(caderno)),
  );

  server.registerTool(
    "ani_ler_folha",
    {
      title: "Ler folha",
      description: "Lê o texto de uma folha de caderno, pelo id (veja ani_ler_caderno).",
      inputSchema: { folhaId: z.string().min(1).describe("Id da folha.") },
      annotations: read,
    },
    ({ folhaId }) => respond(() => ops.readSheet(folhaId)),
  );

  server.registerTool(
    "ani_criar_caderno",
    {
      title: "Criar caderno",
      description: `Cria um caderno vazio. ${WRITES}`,
      inputSchema: { nome: z.string().min(1).max(120).describe("Nome do caderno.") },
      annotations: write,
    },
    ({ nome }) => respond(() => ops.createNotebook(nome)),
  );

  server.registerTool(
    "ani_criar_folha",
    {
      title: "Criar folha",
      description: `Cria uma folha num caderno existente, com título e, se quiser, um texto inicial (parágrafos separados por linha em branco). ${WRITES}`,
      inputSchema: {
        caderno: z.string().min(1).describe("Nome ou id do caderno."),
        titulo: z.string().min(1).max(200).describe("Título da folha."),
        texto: z.string().optional().describe("Texto inicial, opcional."),
      },
      annotations: write,
    },
    ({ caderno, titulo, texto }) => respond(() => ops.createSheet({ notebook: caderno, title: titulo, text: texto })),
  );

  server.registerTool(
    "ani_anotar_na_folha",
    {
      title: "Anotar na folha",
      description: `Acrescenta texto ao fim de uma folha, sem apagar nada. ${WRITES}`,
      inputSchema: {
        folhaId: z.string().min(1).describe("Id da folha (veja ani_ler_caderno)."),
        texto: z.string().min(1).describe("O que anotar."),
      },
      annotations: write,
    },
    ({ folhaId, texto }) => respond(() => ops.appendToSheet({ sheetId: folhaId, text: texto })),
  );

  server.registerTool(
    "ani_listar_roadmaps",
    {
      title: "Listar roadmaps",
      description: "Lista os roadmaps da pessoa (e os compartilhados com ela) com o progresso.",
      annotations: read,
    },
    () => respond(ops.listRoadmaps),
  );

  server.registerTool(
    "ani_ler_roadmap",
    {
      title: "Ler roadmap",
      description:
        "Mostra um roadmap em ordem: tópicos, subtópicos, resumos, progresso e o id de cada cartão (para marcar progresso). Aceita o nome ou o id.",
      inputSchema: { roadmap: z.string().min(1).describe("Nome ou id do roadmap.") },
      annotations: read,
    },
    ({ roadmap }) => respond(() => ops.readRoadmap(roadmap)),
  );

  server.registerTool(
    "ani_marcar_progresso_roadmap",
    {
      title: "Marcar progresso no roadmap",
      description: `Marca um tópico do roadmap como estudando, feito ou sem progresso, pelo id do cartão (veja ani_ler_roadmap). ${WRITES}`,
      inputSchema: {
        cartaoId: z.string().min(1).describe("Id do cartão do roadmap."),
        status: z.enum(["estudando", "feito", "nenhum"]),
      },
      annotations: { ...write, idempotentHint: true },
    },
    ({ cartaoId, status }) => respond(() => ops.setRoadmapProgress({ nodeId: cartaoId, status })),
  );

  server.registerTool(
    "ani_listar_tarefas",
    {
      title: "Listar tarefas",
      description: "Lista as tarefas abertas (guardadas no caderno Tarefas do ANI-9), numeradas.",
      inputSchema: { incluirConcluidas: z.boolean().optional().describe("Mostrar também as concluídas.") },
      annotations: read,
    },
    ({ incluirConcluidas }) => respond(() => ops.listTasks(incluirConcluidas ?? false)),
  );

  server.registerTool(
    "ani_adicionar_tarefa",
    {
      title: "Adicionar tarefa",
      description: `Anota uma tarefa no caderno Tarefas do ANI-9 (cria o caderno na primeira vez). ${WRITES}`,
      inputSchema: { tarefa: z.string().min(1).max(300).describe('Ex.: "revisar Fisiologia até sexta".') },
      annotations: write,
    },
    ({ tarefa }) => respond(() => ops.addTask(tarefa)),
  );

  server.registerTool(
    "ani_concluir_tarefa",
    {
      title: "Concluir tarefa",
      description: `Marca uma tarefa aberta como concluída, pelo número (de ani_listar_tarefas) ou por parte do texto. ${WRITES}`,
      inputSchema: { tarefa: z.string().min(1).describe('Número ("2") ou texto da tarefa.') },
      annotations: { ...write, idempotentHint: true },
    },
    ({ tarefa }) => respond(() => ops.completeTask(tarefa)),
  );

  return server;
}
