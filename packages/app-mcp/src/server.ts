import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalRequest, Decision, PlanRequest } from "./bridge.js";

export const APP_SERVER_NAME = "app";
/** Engine-side names (Claude Code prefixes MCP tools with mcp__<server>__). */
export const APPROVAL_TOOL = `mcp__${APP_SERVER_NAME}__aprovar`;
export const PLAN_TOOL = `mcp__${APP_SERVER_NAME}__confirmar_plano`;

export interface Asker {
  approve(request: ApprovalRequest): Promise<Decision>;
  confirmPlan(request: PlanRequest): Promise<Decision>;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * - aprovar: Claude Code's permission prompt tool. Every call outside the
 *   allowed list lands here and the person decides; the answer format is the
 *   CLI's ({ behavior: "allow", updatedInput } | { behavior: "deny", message }).
 * - confirmar_plano: the model describes a multi-step task before starting;
 *   the app estimates its cost and asks the person.
 */
export function createAppMcpServer(asker: Asker): McpServer {
  const server = new McpServer({ name: APP_SERVER_NAME, version: "0.1.0" });

  server.registerTool(
    "aprovar",
    {
      description: "Uso interno do motor: pede à pessoa permissão para uma ação.",
      inputSchema: { tool_name: z.string(), input: z.unknown(), tool_use_id: z.string().optional() },
    },
    async ({ tool_name, input }) => {
      const decision = await asker.approve({ tool: tool_name, input });
      return text(
        decision.allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: `A pessoa não autorizou: ${decision.reason}` },
      );
    },
  );

  server.registerTool(
    "confirmar_plano",
    {
      title: "Confirmar plano",
      description:
        "Antes de uma pesquisa ou tarefa com vários passos, descreva o plano. A pessoa vê quanto deve custar e decide. Só comece se a resposta for aprovada.",
      inputSchema: {
        resumo: z.string().min(1).describe("O que você vai fazer, em uma frase."),
        passos: z.array(z.string().min(1)).min(1).max(30).describe("Os passos previstos, em ordem."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resumo, passos }) => {
      const decision = await asker.confirmPlan({ summary: resumo, steps: passos });
      return {
        content: [
          {
            type: "text" as const,
            text: decision.allow
              ? "Aprovado. Pode seguir com o plano."
              : `Recusado: ${decision.reason} Não execute o plano; pergunte à pessoa o que ela prefere.`,
          },
        ],
      };
    },
  );

  return server;
}
