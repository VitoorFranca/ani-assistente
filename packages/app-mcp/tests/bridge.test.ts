import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { connectBridge, startBridge, type ApprovalRequest } from "../src/bridge.js";
import { createAppMcpServer } from "../src/server.js";

describe("bridge between the app and the engine's MCP server", () => {
  it("asks the app and returns its decision, in a private folder", async () => {
    const seen: ApprovalRequest[] = [];
    const bridge = await startBridge({
      approve: async (request) => {
        seen.push(request);
        return request.tool.endsWith("criar_nota") ? { allow: true } : { allow: false, reason: "não agora" };
      },
      confirmPlan: async (plan) =>
        plan.steps.length <= 3 ? { allow: true } : { allow: false, reason: "longo demais" },
    });
    try {
      expect(statSync(dirname(bridge.socketPath)).mode & 0o777).toBe(0o700);
      const client = connectBridge(bridge.socketPath, bridge.secret);
      expect(await client.approve({ tool: "mcp__ani9__ani_criar_nota", input: { frente: "a" } })).toEqual({
        allow: true,
      });
      expect(await client.approve({ tool: "mcp__ani9__ani_criar_caderno", input: {} })).toEqual({
        allow: false,
        reason: "não agora",
      });
      expect(await client.confirmPlan({ summary: "x", steps: ["1", "2", "3", "4"] })).toEqual({
        allow: false,
        reason: "longo demais",
      });
      expect(seen.map((s) => s.tool)).toEqual(["mcp__ani9__ani_criar_nota", "mcp__ani9__ani_criar_caderno"]);
    } finally {
      await bridge.close();
    }
  });

  it("refuses requests with a wrong secret, and refuses when the app is gone", async () => {
    let asked = 0;
    const bridge = await startBridge({
      approve: async () => {
        asked++;
        return { allow: true };
      },
      confirmPlan: async () => ({ allow: true }),
    });
    const forged = connectBridge(bridge.socketPath, "segredo-errado");
    expect(await forged.approve({ tool: "x", input: {} })).toEqual({ allow: false, reason: "Pedido sem autorização." });
    expect(asked).toBe(0);
    await bridge.close();
    const late = connectBridge(bridge.socketPath, bridge.secret);
    expect((await late.approve({ tool: "x", input: {} })).allow).toBe(false);
  });

  it("answers Claude Code's permission prompt in the CLI's format", async () => {
    const server = createAppMcpServer({
      approve: async ({ tool }) => (tool === "ok" ? { allow: true } : { allow: false, reason: "recusou" }),
      confirmPlan: async () => ({ allow: true }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const call = async (tool_name: string) =>
      JSON.parse(
        (
          (await client.callTool({ name: "aprovar", arguments: { tool_name, input: { n: 1 } } })).content as {
            text: string;
          }[]
        )[0]!.text,
      );
    expect(await call("ok")).toEqual({ behavior: "allow", updatedInput: { n: 1 } });
    expect(await call("outro")).toEqual({ behavior: "deny", message: "A pessoa não autorizou: recusou" });
  });
});
