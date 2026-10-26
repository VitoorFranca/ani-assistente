import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANI_READ_TOOLS, SERVER_NAME as ANI_SERVER } from "@ani-assistente/ani-mcp";
import { ROADMAP_READ_TOOLS, SERVER_NAME as ROADMAPS_SERVER } from "@ani-assistente/roadmaps-mcp";
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
  type SessionOptions,
  type LimitWindow,
  type Usage,
} from "@ani-assistente/engines";
import { describeAction } from "./describe.js";
import { describeLimits, describeTokens, estimatePlan, type Estimate, type RunHistory } from "./estimate.js";
import { classifyRequest, modelOverride, ROADMAP_PROMPT, SYSTEM_PROMPT, type RequestKind } from "./prompt.js";

export interface AssistantSettings {
  /** Model per kind of request (engine names or aliases). */
  models: Record<RequestKind, string>;
  /** Tokens a run may spend before the assistant stops and asks (per kind). */
  budgets: Record<RequestKind, number>;
  /** A conversation older than this starts fresh. */
  sessionIdleMinutes: number;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  models: { rapido: "haiku", tarefa: "sonnet", roadmap: "sonnet" },
  // A roadmap researches and opens hundreds of pages: a much larger budget, still with the plan confirmed first.
  budgets: { rapido: 40_000, tarefa: 150_000, roadmap: 800_000 },
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
  /** The public roadmap catalog server; without it, roadmap requests run as ordinary tasks. */
  roadmapsMcp?: string;
  /** Where that server keeps its clone of the catalog. */
  roadmapsDir?: string;
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

/** The engine's own tools a roadmap request may use: research on the web. */
const WEB_TOOLS = ["WebSearch", "WebFetch"];

type Profile = "geral" | "roadmap";
const PROFILES: Profile[] = ["geral", "roadmap"];

export async function createAssistant(options: AssistantOptions) {
  const settings: AssistantSettings = {
    ...DEFAULT_SETTINGS,
    ...options.settings,
    models: { ...DEFAULT_SETTINGS.models, ...options.settings?.models },
    budgets: { ...DEFAULT_SETTINGS.budgets, ...options.settings?.budgets },
  };
  const now = options.now ?? (() => new Date());
  let lastActivity = 0;
  let lastLimits: LimitWindow[] = [];
  let current: { kind: RequestKind; model: string; plannedSteps: number | null } | null = null;

  const bridge: Bridge = await startBridge({
    async approve({ tool, input }): Promise<Decision> {
      const yes = await options.prompts.confirmAction(describeAction(tool, input), { tool, input });
      return yes ? { allow: true } : { allow: false, reason: "a pessoa recusou." };
    },
    async confirmPlan({ summary, steps }): Promise<Decision> {
      const history = await options.history.load();
      const estimate = estimatePlan(history, steps.length, current?.model ?? settings.models.tarefa, current?.kind);
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
  const baseServers = {
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
  };
  function writeConfig(name: string, servers: Record<string, unknown>): string {
    const path = join(configDir, name);
    writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  const aniTools = [...ANI_READ_TOOLS.map((tool) => `mcp__${ANI_SERVER}__${tool}`), PLAN_TOOL];
  const common = { approvalTool: APPROVAL_TOOL };
  // Two profiles, each with its own conversation: everyday requests stay lean;
  // roadmap requests add the catalog server and web research (WebSearch, WebFetch).
  const profiles: Record<Profile, Omit<SessionOptions, "model">> = {
    geral: {
      ...common,
      systemPrompt: SYSTEM_PROMPT,
      mcpConfigPath: writeConfig("mcp.json", baseServers),
      allowedTools: aniTools,
    },
    roadmap: options.servers.roadmapsMcp
      ? {
          ...common,
          systemPrompt: `${SYSTEM_PROMPT}\n\n${ROADMAP_PROMPT}`,
          mcpConfigPath: writeConfig("mcp-roadmap.json", {
            ...baseServers,
            [ROADMAPS_SERVER]: {
              command: options.servers.runtime,
              args: [options.servers.roadmapsMcp],
              env: {
                ...options.servers.runtimeEnv,
                ...(options.servers.roadmapsDir && { ROADMAPS_DIR: options.servers.roadmapsDir }),
                ...(process.env.PATH && { PATH: process.env.PATH }),
              },
            },
          }),
          allowedTools: [
            ...aniTools,
            ...ROADMAP_READ_TOOLS.map((tool) => `mcp__${ROADMAPS_SERVER}__${tool}`),
            ...WEB_TOOLS,
          ],
          builtinTools: WEB_TOOLS,
        }
      : { ...common, systemPrompt: SYSTEM_PROMPT, mcpConfigPath: join(configDir, "mcp.json"), allowedTools: aniTools },
  };
  const profileOf = (kind: RequestKind): Profile =>
    kind === "roadmap" && options.servers.roadmapsMcp ? "roadmap" : "geral";

  /** Per profile: the engine's conversation id and a warm engine process kept between requests (only the first pays the start-up). */
  const state: Record<Profile, { sessionId: string | null; live: { model: string; session: EngineSession } | null }> = {
    geral: { sessionId: null, live: null },
    roadmap: { sessionId: null, live: null },
  };

  function session(profile: Profile, model: string): EngineSession | null {
    if (!options.engine.openSession) return null;
    const own = state[profile];
    if (own.live && own.live.session.alive() && own.live.model === model) return own.live.session;
    own.live?.session.close();
    own.live = {
      model,
      session: options.engine.openSession({ ...profiles[profile], model, resumeSessionId: own.sessionId ?? undefined }),
    };
    return own.live.session;
  }

  function stream(profile: Profile, prompt: string, model: string, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const warm = session(profile, model);
    return warm
      ? warm.send(prompt, signal)
      : options.engine.run({
          ...profiles[profile],
          prompt,
          model,
          resumeSessionId: state[profile].sessionId ?? undefined,
          signal,
        });
  }

  function forget(profile: Profile) {
    state[profile].sessionId = null;
    state[profile].live?.session.close();
    state[profile].live = null;
  }

  function expireIfIdle() {
    if (now().getTime() - lastActivity > settings.sessionIdleMinutes * 60_000) {
      for (const profile of PROFILES) if (state[profile].sessionId) forget(profile);
    }
  }

  /** One request from the person, possibly continued past its budget if they agree. */
  async function* ask(text: string, signal?: AbortSignal): AsyncIterable<AssistantEvent> {
    const override = modelOverride(text);
    const prompt = override?.text ?? text;
    const kind = classifyRequest(prompt);
    const model = override?.model ?? settings.models[kind];
    const profile = profileOf(kind);
    expireIfIdle();
    current = { kind, model, plannedSteps: null };
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
          for await (const event of stream(profile, nextPrompt, model, run.signal)) {
            if (event.type === "start") state[profile].sessionId = event.sessionId;
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
              state[profile].sessionId = event.sessionId;
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
      session(profileOf(kind), settings.models[kind]);
    },
    /** Forget the conversation (the next request starts a new session). */
    reset() {
      for (const profile of PROFILES) forget(profile);
    },
    limits: () => lastLimits,
    settings: () => settings,
    async close() {
      for (const profile of PROFILES) state[profile].live?.session.close();
      await bridge.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

export type Assistant = Awaited<ReturnType<typeof createAssistant>>;
