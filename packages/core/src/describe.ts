// Turns an approval request into one sentence a person can answer by voice.

function field(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value.trim() : "";
}

const quote = (text: string, max = 80) => `“${text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}”`;

export function describeAction(tool: string, input: unknown): string {
  // Engines prefix MCP tools with their server (mcp__ani9__ani_criar_nota).
  const name = tool.split("__").at(-1) ?? tool;
  switch (name) {
    case "ani_criar_nota":
      return `Criar o cartão ${quote(field(input, "frente"))} no baralho ${field(input, "baralho")}?`;
    case "ani_criar_caderno":
      return `Criar o caderno ${quote(field(input, "nome"))}?`;
    case "ani_criar_folha":
      return `Criar a folha ${quote(field(input, "titulo"))} no caderno ${field(input, "caderno")}?`;
    case "ani_anotar_na_folha":
      return `Anotar ${quote(field(input, "texto"))} na folha?`;
    case "ani_marcar_progresso_roadmap": {
      const status = field(input, "status");
      return status === "nenhum"
        ? "Apagar o progresso desse tópico do roadmap?"
        : `Marcar o tópico do roadmap como ${status}?`;
    }
    case "ani_adicionar_tarefa":
      return `Anotar a tarefa ${quote(field(input, "tarefa"))}?`;
    case "ani_concluir_tarefa":
      return `Marcar a tarefa ${quote(field(input, "tarefa"))} como concluída?`;
    default:
      return `Permitir a ação ${name.replace(/_/g, " ")}?`;
  }
}
