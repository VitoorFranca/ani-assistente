#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createAssistant, createFileHistory, describeLimits } from "@ani-assistente/core";
import { createClaudeCodeEngine, totalTokens } from "@ani-assistente/engines";

// ani-chat: talk to the assistant in the terminal (same core as the app).
//   ANI_TOKEN=ani9_… [ANI_URL=…] node packages/cli/dist/main.js
// Answers to confirmations: s/sim or n/não.

const token = process.env.ANI_TOKEN?.trim();
if (!token) {
  console.error("Defina ANI_TOKEN com um token do ANI-9 (Configurações → Integrações).");
  process.exit(1);
}
const url = process.env.ANI_URL?.trim() || "https://www.ani9.online";
const packages = fileURLToPath(new URL("../../", import.meta.url));

const engine = createClaudeCodeEngine();
const status = await engine.status();
if (!status.installed || !status.loggedIn) {
  console.error(status.hint ?? "O Claude Code não está pronto.");
  process.exit(1);
}

// Lines are queued: piped input arrives all at once, and none may be lost while the assistant is busy.
const rl = createInterface({ input: process.stdin, terminal: false });
const queue: string[] = [];
const waiting: ((line: string | null) => void)[] = [];
let ended = false;
rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
rl.on("close", () => {
  ended = true;
  while (waiting.length) waiting.shift()!(null);
});

function nextLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (queue.length) return Promise.resolve(queue.shift()!);
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

async function yes(question: string): Promise<boolean> {
  const answer = (await nextLine(`\n? ${question} (s/n) `)) ?? "";
  if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
  return /^(s|sim|pode|ok|y|yes)\b/i.test(answer.trim());
}

const assistant = await createAssistant({
  engine,
  ani: { url, token },
  servers: {
    runtime: process.execPath,
    aniMcp: join(packages, "ani-mcp/dist/index.js"),
    appMcp: join(packages, "app-mcp/dist/main.js"),
  },
  prompts: {
    confirmAction: (question) => yes(question),
    confirmPlan: ({ question }) => yes(question),
    continueOverBudget: ({ question }) => yes(question),
  },
  history: createFileHistory(join(homedir(), ".ani-assistente", "runs.jsonl")),
});

console.log(`Ani pronta (Claude Code ${status.version}, plano ${status.plan}). Escreva e tecle Enter; "sair" encerra.`);
try {
  for (;;) {
    const read = await nextLine("\n> ");
    if (read === null) break; // end of input
    const line = read.trim();
    if (!line) continue;
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    if (/^(sair|exit|quit)$/i.test(line)) break;
    const started = Date.now();
    for await (const event of assistant.ask(line)) {
      if (event.type === "routed") process.stdout.write(`[${event.kind} · ${event.model}] `);
      if (event.type === "text") process.stdout.write(event.delta);
      if (event.type === "tool") process.stdout.write(`\n  · ${event.name.split("__").at(-1)}\n`);
      if (event.type === "error") process.stdout.write(`\n[erro: ${event.message}]`);
      if (event.type === "stopped") process.stdout.write(`\n[${event.reason}]`);
      if (event.type === "done") {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const tokens = Math.round(totalTokens(event.usage) / 1000);
        process.stdout.write(`\n  (${seconds} s · ${tokens} mil tokens · ${describeLimits(assistant.limits())})`);
      }
    }
  }
} finally {
  rl.close();
  await assistant.close();
}
