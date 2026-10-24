import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createClaudeStreamReader } from "./claudeStream.js";
import type { Engine, EngineEvent, EngineStatus, ModelOption, RunRequest } from "./types.js";

// The Claude Code adapter. It runs the `claude` the person installed and
// signed in to, unmodified, as a child process (docs/DECISIONS.md):
// - never reads or stores Claude credentials; status comes from `claude auth status`;
// - never passes --bare (it ignores the subscription login);
// - login is Claude Code's own flow (`claude auth login`), in the person's terminal.

const run = promisify(execFile);

export interface ClaudeCodeOptions {
  /** Path or name of the CLI (default: "claude" on PATH). */
  command?: string;
  /** Opens a command in the person's terminal (for login). */
  openTerminal?: (command: string) => Promise<void>;
}

const MODELS: ModelOption[] = [
  { id: "haiku", label: "Haiku", note: "Rápido e leve: comandos curtos e consultas." },
  { id: "sonnet", label: "Sonnet", note: "Equilíbrio: a maioria das tarefas." },
  { id: "opus", label: "Opus", note: "Mais capaz: pesquisas e tarefas longas. Gasta mais do limite." },
];

const PLAN_NAMES: Record<string, string> = {
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
};

/** The CLI arguments for one run: a lean context (no coding prompt, tools or personal settings). */
export function claudeArgs(request: RunRequest): string[] {
  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt",
    request.systemPrompt,
    "--tools",
    "",
    "--setting-sources",
    "",
    "--mcp-config",
    request.mcpConfigPath,
    "--strict-mcp-config",
  ];
  if (request.allowedTools.length) args.push("--allowedTools", request.allowedTools.join(","));
  if (request.approvalTool) args.push("--permission-prompt-tool", request.approvalTool);
  if (request.model) args.push("--model", request.model);
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  return args;
}

function withoutApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

export function createClaudeCodeEngine(options: ClaudeCodeOptions = {}): Engine {
  const command = options.command ?? "claude";

  async function status(): Promise<EngineStatus> {
    let version: string;
    try {
      version = (await run(command, ["--version"], { timeout: 15_000 })).stdout.trim().split(" ")[0] ?? "";
    } catch {
      return {
        installed: false,
        version: null,
        loggedIn: false,
        plan: null,
        hint: "Instale o Claude Code (code.claude.com) e faça login com a sua conta.",
      };
    }
    try {
      // Only these three fields are read; nothing else from the output is kept.
      const data = JSON.parse((await run(command, ["auth", "status", "--json"], { timeout: 15_000 })).stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      };
      const plan =
        data.authMethod === "claude.ai"
          ? (PLAN_NAMES[data.subscriptionType ?? ""] ?? "Assinatura")
          : data.loggedIn
            ? "Chave de API"
            : null;
      return {
        installed: true,
        version,
        loggedIn: Boolean(data.loggedIn),
        plan,
        hint: data.loggedIn ? null : "Faça login no Claude Code com a sua conta.",
      };
    } catch {
      return {
        installed: true,
        version,
        loggedIn: false,
        plan: null,
        hint: "Faça login no Claude Code com a sua conta.",
      };
    }
  }

  async function login(): Promise<void> {
    if (!options.openTerminal) throw new Error("Abra o Terminal e rode: claude auth login");
    await options.openTerminal(`${command} auth login`);
  }

  async function* runOnce(request: RunRequest): AsyncIterable<EngineEvent> {
    const child = spawn(command, claudeArgs(request), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // The subscription login must win: an API key in the environment would take precedence and bill the API.
      env: withoutApiKey(process.env),
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const onAbort = () => child.kill("SIGINT");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));

    const reader = createClaudeStreamReader();
    let finished = false;
    try {
      const lines = createInterface({ input: child.stdout });
      for await (const line of lines) {
        for (const event of reader.read(line)) {
          if (event.type === "done" || event.type === "error") finished = true;
          yield event;
        }
      }
      const exit = await Promise.race([
        new Promise<number | null>((resolve) => child.once("close", resolve)),
        spawnError.then(() => -1),
      ]);
      if (!finished) {
        if (request.signal?.aborted) yield { type: "error", kind: "aborted", message: "Interrompido." };
        else if (exit === -1) yield { type: "error", kind: "not_installed", message: "Não encontrei o Claude Code." };
        else if (/log ?in|authenticat|unauthori/i.test(stderr)) {
          yield { type: "error", kind: "not_logged_in", message: "Faça login no Claude Code com a sua conta." };
        } else {
          yield {
            type: "error",
            kind: "failed",
            message: stderr.trim().split("\n").at(-1) || `O Claude Code saiu com ${exit}.`,
          };
        }
      }
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }

  return { id: "claude-code", label: "Claude Code", status, login, models: () => MODELS, run: runOnce };
}
