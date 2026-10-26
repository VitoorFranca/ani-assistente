// The contract every AI engine implements. The app speaks only this: adding
// an engine (an API key, Cursor…) means writing one adapter, nothing else.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Part of the input read from the provider's cache (cheaper, faster). */
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const totalTokens = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** How much of a plan's usage window is spent (0–1), when the engine reports it. */
export interface LimitWindow {
  name: string;
  utilization: number;
  resetsAt: Date | null;
}

export type EngineErrorKind = "not_installed" | "not_logged_in" | "limit" | "aborted" | "failed";

export type EngineEvent =
  | { type: "start"; sessionId: string; model: string }
  /** A piece of the answer as it is written (for speaking early). */
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; text: string; isError: boolean }
  /** Running total for this run, after each model call. */
  | { type: "usage"; usage: Usage }
  | { type: "limits"; windows: LimitWindow[] }
  | {
      type: "done";
      text: string;
      sessionId: string;
      usage: Usage;
      costUsd: number | null;
      durationMs: number;
      denied: { tool: string; input: unknown }[];
    }
  | { type: "error"; kind: EngineErrorKind; message: string };

export interface RunRequest {
  prompt: string;
  /** Engine-specific model name or alias; the engine default when absent. */
  model?: string;
  /** Continue this conversation (the engine's session id). */
  resumeSessionId?: string;
  systemPrompt: string;
  /** MCP servers for this run (a JSON config file). */
  mcpConfigPath: string;
  /** Tools that run without asking. Everything else goes to the approval tool. */
  allowedTools: string[];
  /** The engine's own tools to offer (such as web search); none when absent, for a lean context. */
  builtinTools?: string[];
  /** MCP tool that approves or denies every other tool call (deterministic confirmation). */
  approvalTool?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface EngineStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** e.g. "Pro", "Max", "Chave de API". */
  plan: string | null;
  /** What the person should do next, in their words. */
  hint: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
  /** One line: when to use it. */
  note: string;
}

/** Everything a run needs except the prompt: what stays fixed while a session lives. */
export type SessionOptions = Omit<RunRequest, "prompt" | "signal">;

/**
 * A warm conversation: one engine process kept alive between requests, so
 * only the first one pays the start-up. Optional; engines without it use run().
 */
export interface EngineSession {
  send(prompt: string, signal?: AbortSignal): AsyncIterable<EngineEvent>;
  /** The engine's conversation id, once known (to resume elsewhere). */
  sessionId(): string | null;
  alive(): boolean;
  close(): void;
}

export interface Engine {
  id: string;
  label: string;
  status(): Promise<EngineStatus>;
  /** Opens the provider's own login flow; the app never sees credentials. */
  login(): Promise<void>;
  models(): ModelOption[];
  run(request: RunRequest): AsyncIterable<EngineEvent>;
  openSession?(options: SessionOptions): EngineSession;
}
