import { readFileSync, statSync } from "node:fs";
import { connectBridge } from "@ani-assistente/app-mcp";
import type { Engine, EngineEvent, RunRequest, Usage } from "@ani-assistente/engines";
import { describe, expect, it } from "vitest";
import { createAssistant, type AssistantEvent, type PersonPrompts } from "../src/assistant.js";
import { createMemoryHistory } from "../src/history.js";

const usage = (n: number): Usage => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

/** Reads the app's MCP config like Claude Code would, and calls the approval bridge from it. */
function bridgeFrom(request: RunRequest) {
  const config = JSON.parse(readFileSync(request.mcpConfigPath, "utf8"));
  const env = config.mcpServers.app.env;
  return connectBridge(env.ASSISTENTE_SOCKET, env.ASSISTENTE_SECRET);
}

/** An engine whose runs are scripted; each script may use the bridge. */
function scriptedEngine(
  script: (request: RunRequest, call: number) => AsyncIterable<EngineEvent>,
): Engine & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    id: "fake",
    label: "Falso",
    requests,
    status: async () => ({ installed: true, version: "1", loggedIn: true, plan: "Pro", hint: null }),
    login: async () => {},
    models: () => [],
    run(request) {
      requests.push(request);
      return script(request, requests.length);
    },
  };
}

function prompts(answers: Partial<Record<keyof PersonPrompts, boolean>>, asked: string[]): PersonPrompts {
  return {
    confirmAction: async (question) => (asked.push(question), answers.confirmAction ?? true),
    confirmPlan: async ({ question }) => (asked.push(question), answers.confirmPlan ?? true),
    continueOverBudget: async ({ question }) => (asked.push(question), answers.continueOverBudget ?? false),
  };
}

const servers = { runtime: process.execPath, aniMcp: "/x/ani.js", appMcp: "/x/app.js" };
const ani = { url: "http://127.0.0.1:4321", token: "ani9_teste" };

async function collect(events: AsyncIterable<AssistantEvent>) {
  const all: AssistantEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("assistant: roadmaps", () => {
  it("runs roadmap requests in their own conversation, with the catalog server and web research", async () => {
    const engine = scriptedEngine(async function* (request) {
      const id = request.builtinTools?.length ? "roteiro" : "geral";
      yield { type: "start", sessionId: id, model: "claude-sonnet" };
      yield { type: "done", text: "ok", sessionId: id, usage: usage(1000), costUsd: null, durationMs: 1, denied: [] };
    });
    const assistant = await createAssistant({
      engine,
      ani,
      servers: { ...servers, roadmapsMcp: "/x/roadmaps.js", roadmapsDir: "/tmp/catalogo" },
      prompts: prompts({}, []),
      history: createMemoryHistory(),
    });
    try {
      const routed = await collect(assistant.ask("Cria um roadmap de química orgânica"));
      expect(routed[0]).toEqual({ type: "routed", kind: "roadmap", model: "sonnet" });
      const roadmap = engine.requests[0]!;
      expect(roadmap.builtinTools).toEqual(["WebSearch", "WebFetch"]);
      expect(roadmap.allowedTools).toEqual(
        expect.arrayContaining([
          "WebSearch",
          "WebFetch",
          "mcp__roadmaps__roadmap_preparar",
          "mcp__roadmaps__roadmap_salvar_e_validar",
        ]),
      );
      // Publishing always asks: the pull request tool is not allowed by default.
      expect(roadmap.allowedTools).not.toContain("mcp__roadmaps__roadmap_abrir_pr");
      expect(roadmap.systemPrompt).toContain("roadmap_preparar");
      const config = JSON.parse(readFileSync(roadmap.mcpConfigPath, "utf8"));
      expect(config.mcpServers.roadmaps.env.ROADMAPS_DIR).toBe("/tmp/catalogo");

      // An everyday request stays lean: no web tools, no catalog server, its own conversation.
      await collect(assistant.ask("Quantas revisões eu tenho hoje?"));
      const everyday = engine.requests[1]!;
      expect(everyday.builtinTools).toBeUndefined();
      expect(JSON.parse(readFileSync(everyday.mcpConfigPath, "utf8")).mcpServers.roadmaps).toBeUndefined();
      expect(everyday.resumeSessionId).toBeUndefined();
      // Back to the roadmap: its conversation continues.
      await collect(assistant.ask("Revisa o roadmap de química e melhora as fontes"));
      expect(engine.requests[2]!.resumeSessionId).toBe("roteiro");
    } finally {
      await assistant.close();
    }
  });

  it("without the catalog server, a roadmap request runs as an ordinary task", async () => {
    const engine = scriptedEngine(async function* () {
      yield { type: "done", text: "ok", sessionId: "s", usage: usage(10), costUsd: null, durationMs: 1, denied: [] };
    });
    const assistant = await createAssistant({
      engine,
      ani,
      servers,
      prompts: prompts({}, []),
      history: createMemoryHistory(),
    });
    try {
      await collect(assistant.ask("Cria um roadmap de química"));
      expect(engine.requests[0]!.builtinTools).toBeUndefined();
    } finally {
      await assistant.close();
    }
  });
});

describe("assistant", () => {
  it("routes the request, lets reads run and keeps the ANI-9 token in a private config", async () => {
    const engine = scriptedEngine(async function* () {
      yield { type: "start", sessionId: "s1", model: "claude-haiku" };
      yield {
        type: "done",
        text: "Você tem 7 revisões hoje.",
        sessionId: "s1",
        usage: usage(9000),
        costUsd: null,
        durationMs: 1500,
        denied: [],
      };
    });
    const history = createMemoryHistory();
    const assistant = await createAssistant({ engine, ani, servers, prompts: prompts({}, []), history });
    try {
      const events = await collect(assistant.ask("Quantas revisões eu tenho hoje?"));
      expect(events[0]).toEqual({ type: "routed", kind: "rapido", model: "haiku" });
      expect(events.at(-1)).toMatchObject({ type: "done", text: "Você tem 7 revisões hoje." });
      const request = engine.requests[0]!;
      expect(request.model).toBe("haiku");
      expect(request.approvalTool).toBe("mcp__app__aprovar");
      expect(request.allowedTools).toContain("mcp__ani9__ani_resumo_do_dia");
      expect(request.allowedTools).not.toContain("mcp__ani9__ani_criar_nota");
      expect(statSync(request.mcpConfigPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(request.mcpConfigPath, "utf8")).mcpServers.ani9.env.ANI_TOKEN).toBe("ani9_teste");
      expect(history.records).toMatchObject([{ kind: "rapido", model: "haiku", tokens: 9000, steps: null }]);

      // The next request continues the same conversation.
      await collect(assistant.ask("E amanhã?"));
      expect(engine.requests[1]!.resumeSessionId).toBe("s1");
    } finally {
      await assistant.close();
    }
  });

  it("asks the person before a write, in a sentence, and passes the answer back", async () => {
    const decisions: unknown[] = [];
    const engine = scriptedEngine(async function* (request) {
      yield { type: "start", sessionId: "s", model: "m" };
      decisions.push(
        await bridgeFrom(request).approve({
          tool: "mcp__ani9__ani_criar_nota",
          input: { baralho: "Fisiologia", frente: "O que é ATP?" },
        }),
      );
      yield { type: "done", text: "ok", sessionId: "s", usage: usage(100), costUsd: null, durationMs: 1, denied: [] };
    });
    const asked: string[] = [];
    const assistant = await createAssistant({
      engine,
      ani,
      servers,
      prompts: prompts({ confirmAction: false }, asked),
      history: createMemoryHistory(),
    });
    try {
      await collect(assistant.ask("Cria um cartão sobre ATP em Fisiologia"));
      expect(asked).toEqual(["Criar o cartão “O que é ATP?” no baralho Fisiologia?"]);
      expect(decisions).toEqual([{ allow: false, reason: "a pessoa recusou." }]);
    } finally {
      await assistant.close();
    }
  });

  it("estimates a plan before a long task and records its steps", async () => {
    const engine = scriptedEngine(async function* (request) {
      yield { type: "start", sessionId: "s", model: "m" };
      yield { type: "limits", windows: [{ name: "5 horas", utilization: 0.3, resetsAt: null }] };
      await bridgeFrom(request).confirmPlan({
        summary: "Vou criar cartões do caderno.",
        steps: ["ler", "escrever", "criar"],
      });
      yield {
        type: "done",
        text: "Pronto.",
        sessionId: "s",
        usage: usage(30_000),
        costUsd: null,
        durationMs: 1,
        denied: [],
      };
    });
    const asked: string[] = [];
    const history = createMemoryHistory();
    const assistant = await createAssistant({ engine, ani, servers, prompts: prompts({}, asked), history });
    try {
      const events = await collect(assistant.ask("Cria vários cartões a partir do caderno de Bioquímica"));
      expect(events[0]).toEqual({ type: "routed", kind: "tarefa", model: "sonnet" });
      expect(asked).toEqual([
        "Vou criar cartões do caderno. São 3 passos, deve gastar entre 18 e 45 mil tokens. Você já usou 30% da janela de 5 horas. Posso seguir?",
      ]);
      expect(history.records).toMatchObject([{ kind: "tarefa", steps: 3, tokens: 30_000 }]);
    } finally {
      await assistant.close();
    }
  });

  it("stops a run that passes its budget, asks, and continues the same session when allowed", async () => {
    const engine = scriptedEngine(async function* (request, call) {
      yield { type: "start", sessionId: "longa", model: "m" };
      if (call === 1) {
        yield { type: "usage", usage: usage(30_000) };
        yield { type: "usage", usage: usage(45_000) }; // past the 40k quick budget
        // The real engine stops when aborted:
        while (!request.signal?.aborted) await new Promise((r) => setTimeout(r, 5));
        yield { type: "error", kind: "aborted", message: "Interrompido." };
        return;
      }
      yield {
        type: "done",
        text: "Terminei.",
        sessionId: "longa",
        usage: usage(10_000),
        costUsd: null,
        durationMs: 1,
        denied: [],
      };
    });
    const asked: string[] = [];
    const history = createMemoryHistory();
    const assistant = await createAssistant({
      engine,
      ani,
      servers,
      prompts: prompts({ continueOverBudget: true }, asked),
      history,
    });
    try {
      const events = await collect(assistant.ask("Quanto falta no roadmap?"));
      expect(asked).toEqual([
        "Esta tarefa já usou cerca de 45 mil tokens, mais que o limite de cerca de 40 mil tokens. Continuo?",
      ]);
      expect(engine.requests[1]).toMatchObject({
        prompt: "Continue a tarefa de onde parou.",
        resumeSessionId: "longa",
      });
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done", text: "Terminei." });
      expect(history.records[0]!.tokens).toBe(55_000);
    } finally {
      await assistant.close();
    }
  });

  it("uses the model named in the request", async () => {
    const engine = scriptedEngine(async function* () {
      yield { type: "done", text: "ok", sessionId: "s", usage: usage(1), costUsd: null, durationMs: 1, denied: [] };
    });
    const assistant = await createAssistant({
      engine,
      ani,
      servers,
      prompts: prompts({}, []),
      history: createMemoryHistory(),
    });
    try {
      await collect(assistant.ask("usa o opus nisso: quantas revisões tenho?"));
      expect(engine.requests[0]).toMatchObject({ model: "opus", prompt: "quantas revisões tenho?" });
    } finally {
      await assistant.close();
    }
  });
});

describe("warm sessions", () => {
  function sessionEngine() {
    const opened: { model?: string; resume?: string }[] = [];
    const prompts: string[] = [];
    const engine: Engine = {
      id: "s",
      label: "Sessões",
      status: async () => ({ installed: true, version: "1", loggedIn: true, plan: "Pro", hint: null }),
      login: async () => {},
      models: () => [],
      run: () => {
        throw new Error("não deveria usar run");
      },
      openSession(options) {
        opened.push({ model: options.model, resume: options.resumeSessionId });
        let alive = true;
        return {
          async *send(prompt) {
            prompts.push(prompt);
            yield { type: "start", sessionId: "conversa", model: options.model ?? "" };
            yield {
              type: "done",
              text: "ok",
              sessionId: "conversa",
              usage: usage(100),
              costUsd: null,
              durationMs: 1,
              denied: [],
            };
          },
          sessionId: () => "conversa",
          alive: () => alive,
          close: () => void (alive = false),
        };
      },
    };
    return { engine, opened, prompts };
  }

  it("reuses one process across requests and reopens it, resuming the conversation, when the model changes", async () => {
    const { engine, opened, prompts } = sessionEngine();
    const assistant = await createAssistant({
      engine,
      ani,
      servers,
      prompts: prompts_({}),
      history: createMemoryHistory(),
    });
    try {
      assistant.warm();
      await collect(assistant.ask("Quantas revisões tenho?"));
      await collect(assistant.ask("E tarefas?"));
      expect(opened).toEqual([{ model: "haiku", resume: undefined }]);
      await collect(assistant.ask("usa o opus nisso: e amanhã?"));
      expect(opened[1]).toEqual({ model: "opus", resume: "conversa" });
      expect(prompts).toEqual(["Quantas revisões tenho?", "E tarefas?", "e amanhã?"]);
    } finally {
      await assistant.close();
    }
  });
});

function prompts_(answers: Partial<Record<keyof PersonPrompts, boolean>>): PersonPrompts {
  return prompts(answers, []);
}
