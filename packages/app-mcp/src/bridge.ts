import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The app and the MCP server the engine starts are different processes. They
// talk over a Unix socket in a private folder (0700), one JSON object per
// line, and every request carries a per-session secret: nothing else on the
// machine can approve an action.

export interface ApprovalRequest {
  /** Full tool name as the engine calls it (e.g. mcp__ani9__ani_criar_nota). */
  tool: string;
  input: unknown;
}

export interface PlanRequest {
  summary: string;
  steps: string[];
}

export type Decision = { allow: true } | { allow: false; reason: string };

export interface BridgeHandlers {
  approve(request: ApprovalRequest): Promise<Decision>;
  confirmPlan(request: PlanRequest): Promise<Decision>;
}

type Message =
  | { id: number; secret: string; kind: "approve"; payload: ApprovalRequest }
  | { id: number; secret: string; kind: "plan"; payload: PlanRequest };

export interface Bridge {
  socketPath: string;
  secret: string;
  close(): Promise<void>;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** App side: listens for approval and plan requests. */
export async function startBridge(handlers: BridgeHandlers): Promise<Bridge> {
  const dir = mkdtempSync(join(tmpdir(), "ani-assistente-")); // created 0700
  const socketPath = join(dir, "bridge.sock");
  const secret = randomBytes(24).toString("base64url");

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handle(socket, line);
      }
    });
    socket.on("error", () => {});
  });

  async function handle(socket: Socket, line: string) {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    const reply = (decision: Decision) => socket.write(`${JSON.stringify({ id: message.id, decision })}\n`);
    if (typeof message.secret !== "string" || !sameSecret(message.secret, secret)) {
      return reply({ allow: false, reason: "Pedido sem autorização." });
    }
    try {
      reply(
        message.kind === "plan" ? await handlers.confirmPlan(message.payload) : await handlers.approve(message.payload),
      );
    } catch (error) {
      reply({ allow: false, reason: error instanceof Error ? error.message : "Falha ao perguntar." });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    secret,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** MCP side: asks the app and waits. Anything that goes wrong is a refusal. */
export function connectBridge(socketPath: string, secret: string, timeoutMs = 10 * 60_000) {
  let nextId = 1;
  function ask(kind: "approve" | "plan", payload: ApprovalRequest | PlanRequest): Promise<Decision> {
    const id = nextId++;
    return new Promise<Decision>((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      const done = (decision: Decision) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(decision);
      };
      const timer = setTimeout(() => done({ allow: false, reason: "Sem resposta da pessoa a tempo." }), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, secret, kind, payload })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const answer = JSON.parse(buffer.slice(0, newline)) as { id: number; decision: Decision };
          if (answer.id === id) done(answer.decision);
        } catch {
          done({ allow: false, reason: "Resposta inválida do app." });
        }
      });
      socket.on("error", () => done({ allow: false, reason: "O app do assistente não respondeu." }));
    });
  }
  return {
    approve: (request: ApprovalRequest) => ask("approve", request),
    confirmPlan: (request: PlanRequest) => ask("plan", request),
  };
}
