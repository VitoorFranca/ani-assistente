import { z } from "zod";

// IPC between the window and the main process. Both ends validate with these
// schemas: the renderer cannot ask for anything that is not listed here.

export const toMain = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ask"), text: z.string().min(1).max(4000) }),
  /** Start or stop listening (the microphone button). */
  z.object({ type: z.literal("listen") }),
  z.object({
    type: z.literal("saveVoice"),
    enabled: z.boolean().optional(),
    wake: z.boolean().optional(),
    tts: z.string().max(40).optional(),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("answer"), id: z.number().int(), yes: z.boolean() }),
  z.object({ type: z.literal("reset") }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("login") }),
  z.object({ type: z.literal("saveToken"), token: z.string().regex(/^ani9_[A-Za-z0-9_-]{43}$/, "Token inválido.") }),
  z.object({ type: z.literal("forgetToken") }),
  z.object({
    type: z.literal("saveSettings"),
    aniUrl: z.url().optional(),
    quickModel: z.string().min(1).max(60).optional(),
    taskModel: z.string().min(1).max(60).optional(),
    quickBudget: z.number().int().min(5_000).max(2_000_000).optional(),
    taskBudget: z.number().int().min(5_000).max(2_000_000).optional(),
  }),
]);
export type ToMain = z.infer<typeof toMain>;

const limit = z.object({ name: z.string(), utilization: z.number(), resetsAt: z.string().nullable() });

export const toRenderer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    engine: z.object({
      label: z.string(),
      installed: z.boolean(),
      loggedIn: z.boolean(),
      plan: z.string().nullable(),
      version: z.string().nullable(),
      hint: z.string().nullable(),
    }),
    ani: z.object({
      connected: z.boolean(),
      account: z.string().nullable(),
      url: z.string(),
      error: z.string().nullable(),
    }),
    models: z.array(z.object({ id: z.string(), label: z.string(), note: z.string() })),
    settings: z.object({
      quickModel: z.string(),
      taskModel: z.string(),
      quickBudget: z.number(),
      taskBudget: z.number(),
    }),
    limits: z.array(limit),
    voice: z.object({
      enabled: z.boolean(),
      available: z.boolean(),
      wake: z.boolean(),
      tts: z.string(),
      voices: z.array(z.object({ id: z.string(), label: z.string(), note: z.string() })),
    }),
  }),
  z.object({ type: z.literal("routed"), kind: z.string(), model: z.string() }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("limits"), windows: z.array(limit) }),
  z.object({ type: z.literal("usage"), tokens: z.number() }),
  z.object({ type: z.literal("done"), text: z.string(), tokens: z.number(), seconds: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("stopped"), reason: z.string() }),
  /** A question only the person can answer; reply with { type: "answer", id, yes }. */
  z.object({
    type: z.literal("question"),
    id: z.number().int(),
    kind: z.enum(["action", "plan", "budget"]),
    text: z.string(),
    steps: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("questionClosed"), id: z.number().int() }),
  /** What the voice is doing, for the panel. */
  z.object({
    type: z.literal("voice"),
    state: z.enum(["off", "loading", "idle", "listening", "hearing", "speaking"]),
    level: z.number().optional(),
    detail: z.string().optional(),
  }),
  /** A request that came by voice: shown as if typed. */
  z.object({ type: z.literal("heard"), text: z.string() }),
]);
export type ToRenderer = z.infer<typeof toRenderer>;
