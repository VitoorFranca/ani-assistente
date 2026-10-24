// Calls every read tool and a few writes through the real stdio server.
//   ANI_URL=http://127.0.0.1:4321 ANI_TOKEN=ani9_… node scripts/smoke.mjs [--writes]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const writes = process.argv.includes("--writes");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ANI_URL: process.env.ANI_URL ?? "", ANI_TOKEN: process.env.ANI_TOKEN ?? "", PATH: process.env.PATH ?? "" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

async function call(name, args = {}) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join("\n");
  console.log(
    `\n### ${name} ${JSON.stringify(args)} (${Math.round(performance.now() - started)} ms)${result.isError ? " [ERRO]" : ""}\n${text}`,
  );
  return text;
}

await call("ani_conta");
await call("ani_resumo_do_dia");
await call("ani_estatisticas");
await call("ani_listar_baralhos");
await call("ani_buscar_cartoes", { busca: "is:due", limite: 3 });
await call("ani_listar_cadernos");
await call("ani_ler_caderno", { caderno: "Biologia celular" });
await call("ani_listar_roadmaps");
await call("ani_ler_roadmap", { roadmap: "Front-end" });
await call("ani_ler_caderno", { caderno: "Bolha" });
if (writes) {
  await call("ani_adicionar_tarefa", { tarefa: "testar o assistente por voz" });
  await call("ani_listar_tarefas");
  await call("ani_concluir_tarefa", { tarefa: "assistente" });
  await call("ani_listar_tarefas", { incluirConcluidas: true });
}
await client.close();
