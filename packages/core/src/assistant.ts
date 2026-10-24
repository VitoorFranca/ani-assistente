import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANI_READ_TOOLS, SERVER_NAME as ANI_SERVER } from "@ani-assistente/ani-mcp";
import {
  APP_SERVER_NAME,
  APPROVAL_TOOL,
  PLAN_TOOL,
  startBridge,
  type Bridge,
  type Decision,
} from "@ani-assistente/app-mcp";
import {
  totalTokens,
  type Engine,
  type EngineEvent,
  type EngineSession,
  type LimitWindow,
  type Usage,
} from "@ani-assistente/engines";
import { describeAction } from "./describe.js";
import { describeLimits, describeTokens, estimatePlan, type Estimate, type RunHistory } from "./estimate.js";
import { classifyRequest, modelOverride, SYSTEM_PROMPT, type RequestKind } from "./prompt.js";

export interface AssistantSettings {
  /** Model per kind of request (engine names or aliases). */
  models: Record<RequestKind, string>;
  /** Tokens a run may spend before the assistant stops and asks (per kind). */
  budgets: Record<RequestKind, number>;
  /** A conversation older than this starts fresh. */
  sessionIdleMinutes: number;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  models: { rapido: "haiku", tarefa: "sonnet" },
  budgets: { rapido: 40_000, tarefa: 150_000 },
  sessionIdleMinutes: 15,
};

/** Questions only the person can answer (by voice or click). */
export interface PersonPrompts {
  /** "Criar o cartão … no baralho …?" */
  confirmAction(question: string, detail: { tool: string; input: unknown }): Promise<boolean>;
  /** A multi-step plan with its estimate. */
  confirmPlan(plan: { summary: string; steps: string[]; estimate: Estimate; question: string }): Promise<boolean>;
  /** The run passed its budget: keep going? */
  continueOverBudget(info: { used: number; budget: number; question: string }): Promise<boolean>;
}

export interface ServerPaths {
  /** The program that runs the MCP servers (node, or Electron with ELECTRON_RUN_AS_NODE). */
  runtime: string;
  runtimeEnv?: Record<string, string>;
  aniMcp: string;
  appMcp: string;
}

export type AssistantEvent =
  | { type: "routed"; kind: RequestKind; model: string }
  | Exclude<EngineEvent, { type: "done" }>
  | { type: "done"; text: string; usage: Usage; costUsd: number | null }
  | { type: "stopped"; reason: string };

export interface AssistantOptions {
  engine: Engine;
  ani: { url: string; token: string };
  servers: ServerPaths;
  prompts: PersonPrompts;
  history: RunHistory;
  settings?: Partial<AssistantSettings>;
  now?: () => Date;
}

const CONTINUE_PROMPT = "Continue a tarefa de onde parou.";

export async function createAssistant(options: AssistantOptions) {
  const settings: AssistantSettings = {
    ...DEFAULT_SETTINGS,
    ...options.settings,
    models: { ...DEFAULT_SETTINGS.models, ...options.settings?.models },
    budgets: { ...DEFAULT_SETTINGS.budgets, ...options.settings?.budgets },
  };
  const now = options.now ?? (() => new Date());
  let sessionId: string | null = null;
  let lastActivity = 0;
  let lastLimits: LimitWindow[] = [];
  let current: { model: string; plannedSteps: number | null } | null = null;

  const bridge: Bridge = await startBridge({
    async approve({ tool, input }): Promise<Decision> {
      const yes = await options.prompts.confirmAction(describeAction(tool, input), { tool, input });
      return yes ? { allow: true } : { allow: false, reason: "a pessoa recusou." };
    },
    async confirmPlan({ summary, steps }): Promise<Decision> {
      const history = await options.history.load();
      const estimate = estimatePlan(history, steps.length, current?.model ?? settings.models.tarefa);
      const question = [
        `${summary} São ${steps.length} ${steps.length === 1 ? "passo" : "passos"}, deve gastar ${describeTokens(estimate.low, estimate.high)}.`,
        describeLimits(lastLimits),
        "Posso seguir?",
      ]
        .filter(Boolean)
        .join(" ");
      const yes = await options.prompts.confirmPlan({ summary, steps, estimate, question });
      if (yes && current) current.plannedSteps = steps.length;
      return yes ? { allow: true } : { allow: false, reason: "a pessoa preferiu não seguir." };
    },
  });

  // MCP servers for every run: the ANI-9 and the app's approval bridge. The
  // file holds the ANI-9 token, so it lives in a private folder, readable only by the person.
  const configDir = mkdtempSync(join(tmpdir(), "ani-assistente-config-"));
  const mcpConfigPath = join(configDir, "mcp.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [ANI_SERVER]: {
          command: options.servers.runtime,
          args: [options.servers.aniMcp],
          env: { ...options.servers.runtimeEnv, ANI_URL: options.ani.url, ANI_TOKEN: options.ani.token },
        },
        [APP_SERVER_NAME]: {
          command: options.servers.runtime,
          args: [options.servers.appMcp],
          env: {
            ...options.servers.runtimeEnv,
            ASSISTENTE_SOCKET: bridge.socketPath,
            ASSISTENTE_SECRET: bridge.secret,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(mcpConfigPath, 0o600);

  const allowedTools = [...ANI_READ_TOOLS.map((tool) => `mcp__${ANI_SERVER}__${tool}`), PLAN_TOOL];
  const fixed = { systemPrompt: SYSTEM_PROMPT, mcpConfigPath, allowedTools, approvalTool: APPROVAL_TOOL };

  // A warm engine process kept between requests (when the engine offers it): only the first request pays the start-up.
  let live: { model: string; session: EngineSession } | null = null;

  function session(model: string): EngineSession | null {
    if (!options.engine.openSession) return null;
    if (live && live.session.alive() && live.model === model) return live.session;
    live?.session.close();
    live = { model, session: options.engine.openSession({ ...fixed, model, resumeSessionId: sessionId ?? undefined }) };
    return live.session;
  }

  function stream(prompt: string, model: string, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const warm = session(model);
    return warm
      ? warm.send(prompt, signal)
      : options.engine.run({ ...fixed, prompt, model, resumeSessionId: sessionId ?? undefined, signal });
  }

  function expireIfIdle() {
    if (sessionId && now().getTime() - lastActivity > settings.sessionIdleMinutes * 60_000) {
      sessionId = null;
      live?.session.close();
      live = null;
    }
  }

  /** One request from the person, possibly continued past its budget if they agree. */
  async function* ask(text: string, signal?: AbortSignal): AsyncIterable<AssistantEvent> {
    const override = modelOverride(text);
    const prompt = override?.text ?? text;
    const kind = classifyRequest(prompt);
    const model = override?.model ?? settings.models[kind];
    expireIfIdle();
    current = { model, plannedSteps: null };
    yield { type: "routed", kind, model };

    let budget = settings.budgets[kind];
    let spentBefore = 0;
    let nextPrompt = prompt;
    let total: Usage | null = null;
    try {
      for (;;) {
        const run = new AbortController();
        const onAbort = () => run.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        let overBudget = false;
        let finished = false;
        let used = 0;
        try {
          for await (const event of stream(nextPrompt, model, run.signal)) {
            if (event.type === "start") sessionId = event.sessionId;
            if (event.type === "limits") lastLimits = event.windows;
            if (event.type === "usage") {
              used = totalTokens(event.usage);
              if (spentBefore + used > budget && !run.signal.aborted) {
                overBudget = true;
                run.abort();
              }
            }
            if (event.type === "done") {
              finished = true;
              sessionId = event.sessionId;
              total = event.usage;
              spentBefore += totalTokens(event.usage);
              yield { type: "done", text: event.text, usage: event.usage, costUsd: event.costUsd };
              continue;
            }
            if (event.type === "error" && event.kind === "aborted" && overBudget) continue;
            yield event;
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
        if (finished || !overBudget || signal?.aborted) break;

        spentBefore += used;
        const question = `Esta tarefa já usou ${describeTokens(spentBefore, spentBefore)}, mais que o limite de ${describeTokens(budget, budget)}. Continuo?`;
        const keepGoing = await options.prompts.continueOverBudget({ used: spentBefore, budget, question });
        if (!keepGoing) {
          yield { type: "stopped", reason: "Parei a tarefa no limite de tokens, a seu pedido." };
          break;
        }
        budget = spentBefore + settings.budgets[kind];
        nextPrompt = CONTINUE_PROMPT;
      }
    } finally {
      lastActivity = now().getTime();
      if (total || spentBefore) {
        await options.history.append({
          at: now().toISOString(),
          kind,
          model,
          steps: current?.plannedSteps ?? null,
          tokens: spentBefore || (total ? totalTokens(total) : 0),
        });
      }
      current = null;
    }
  }

  return {
    ask,
    /** Start the engine ahead of a request (when the person starts talking), so it is ready when the text arrives. */
    warm(kind: RequestKind = "rapido") {
      expireIfIdle();
      session(settings.models[kind]);
    },
    /** Forget the conversation (the next request starts a new session). */
    reset() {
      sessionId = null;
      live?.session.close();
      live = null;
    },
    limits: () => lastLimits,
    settings: () => settings,
    async close() {
      live?.session.close();
      await bridge.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

export type Assistant = Awaited<ReturnType<typeof createAssistant>>;
