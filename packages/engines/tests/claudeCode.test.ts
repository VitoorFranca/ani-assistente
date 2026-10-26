import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, createClaudeCodeEngine } from "../src/claudeCode.js";
import { createClaudeStreamReader } from "../src/claudeStream.js";
import { totalTokens, type EngineEvent, type RunRequest } from "../src/types.js";

const fake = new URL("./fake-claude.mjs", import.meta.url).pathname;
const fixture = readFileSync(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");

const request: RunRequest = {
  prompt: "Quantas tarefas abertas eu tenho?",
  systemPrompt: "Você é a Ani.",
  mcpConfigPath: "/tmp/mcp.json",
  allowedTools: ["mcp__ani9__ani_listar_tarefas", "mcp__ani9__ani_conta"],
  approvalTool: "mcp__app__aprovar",
  model: "haiku",
};

async function collect(events: AsyncIterable<EngineEvent>) {
  const all: EngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("claude stream reader (recorded run)", () => {
  it("turns the run into start, tool, result, text, usage, limits and done events", () => {
    const reader = createClaudeStreamReader();
    const events = fixture.split("\n").flatMap((line) => reader.read(line));
    expect(events[0]).toMatchObject({ type: "start", model: "claude-haiku-5-5" });
    expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "mcp__ani9__ani_listar_tarefas" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: false });
    const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.text).toBe(text);
    expect(done?.type === "done" && totalTokens(done.usage)).toBeGreaterThan(1000);
    const limits = events.find((e) => e.type === "limits");
    expect(limits?.type === "limits" && limits.windows.map((w) => w.name)).toEqual(["5 horas", "semana"]);
    // Usage grows call by call.
    const usages = events.flatMap((e) => (e.type === "usage" ? [totalTokens(e.usage)] : []));
    expect(usages.length).toBe(2);
    expect(usages[1]!).toBeGreaterThan(usages[0]!);
  });

  it("ignores lines it does not understand", () => {
    const reader = createClaudeStreamReader();
    expect(reader.read("not json")).toEqual([]);
    expect(reader.read('{"type":"something_new"}')).toEqual([]);
  });

  it("reports a failed run as an error", () => {
    const reader = createClaudeStreamReader();
    expect(
      reader.read(
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Usage limit reached"}',
      ),
    ).toEqual([{ type: "error", kind: "limit", message: "Usage limit reached" }]);
  });
});

describe("Claude Code engine", () => {
  it("builds a lean command line, never --bare", () => {
    const args = claudeArgs({ ...request, resumeSessionId: "abc" });
    expect(args).not.toContain("--bare");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    // Built-in tools only when asked for (web research for roadmaps).
    const web = claudeArgs({ ...request, builtinTools: ["WebSearch", "WebFetch"] });
    expect(web.slice(web.indexOf("--tools"), web.indexOf("--tools") + 2)).toEqual(["--tools", "WebSearch,WebFetch"]);
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual([
      "--allowedTools",
      "mcp__ani9__ani_listar_tarefas,mcp__ani9__ani_conta",
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--permission-prompt-tool",
        "mcp__app__aprovar",
        "--model",
        "haiku",
        "--resume",
        "abc",
        "--strict-mcp-config",
      ]),
    );
  });

  it("reads status from the CLI and keeps only login and plan", async () => {
    const status = await createClaudeCodeEngine({ command: fake }).status();
    expect(status).toEqual({ installed: true, version: "2.1.300", loggedIn: true, plan: "Max", hint: null });
    expect(JSON.stringify(status)).not.toContain("example.com");
  });

  it("says when the CLI is missing", async () => {
    const status = await createClaudeCodeEngine({ command: "/nao/existe/claude" }).status();
    expect(status.installed).toBe(false);
    expect(status.hint).toMatch(/Instale o Claude Code/);
  });

  it("runs the CLI and streams its events, without an API key in its environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-"));
    process.env.FAKE_CLAUDE_ARGS = join(dir, "args.jsonl");
    process.env.ANTHROPIC_API_KEY = "sk-nao-deve-passar";
    try {
      const events = await collect(createClaudeCodeEngine({ command: fake }).run(request));
      expect(events.at(-1)?.type).toBe("done");
      const recorded = readFileSync(process.env.FAKE_CLAUDE_ARGS, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(recorded.at(-1)).toEqual({ args: claudeArgs(request), apiKey: null });
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("turns a login failure into a clear error", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    try {
      const events = await collect(createClaudeCodeEngine({ command: fake }).run(request));
      expect(events).toEqual([
        { type: "error", kind: "not_logged_in", message: "Faça login no Claude Code com a sua conta." },
      ]);
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
    }
  });
});

describe("warm session", () => {
  it("answers several requests from one process, each with its own usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-"));
    process.env.FAKE_CLAUDE_ARGS = join(dir, "args.jsonl");
    process.env.FAKE_CLAUDE_INPUTS = join(dir, "inputs.txt");
    try {
      const session = createClaudeCodeEngine({ command: fake }).openSession!(request);
      const first = await collect(session.send("primeira"));
      const second = await collect(session.send("segunda"));
      expect(first[0]).toMatchObject({ type: "start" });
      expect(second.find((e) => e.type === "start")).toBeUndefined();
      const tokens = (events: EngineEvent[]) => {
        const done = events.find((e) => e.type === "done");
        return done?.type === "done" ? totalTokens(done.usage) : 0;
      };
      expect(tokens(second)).toBe(tokens(first));
      expect(session.sessionId()).toBe("efd218a8-47a9-4346-9338-5ac08becc56b");
      expect(readFileSync(process.env.FAKE_CLAUDE_INPUTS, "utf8")).toBe("primeira\nsegunda\n");
      // One process for both requests, in stream-json input mode, never --bare.
      const runs = readFileSync(process.env.FAKE_CLAUDE_ARGS, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(runs).toHaveLength(1);
      expect(runs[0].args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
      expect(runs[0].args).not.toContain("--bare");
      session.close();
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
      delete process.env.FAKE_CLAUDE_INPUTS;
    }
  });

  it("ends the process when a request is interrupted", async () => {
    const session = createClaudeCodeEngine({ command: fake }).openSession!(request);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const events = await collect(session.send("pendura", controller.signal));
    expect(events.at(-1)).toEqual({ type: "error", kind: "aborted", message: "Interrompido." });
    await new Promise((r) => setTimeout(r, 100));
    expect(session.alive()).toBe(false);
  });
});
