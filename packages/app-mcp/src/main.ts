#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectBridge } from "./bridge.js";
import { createAppMcpServer } from "./server.js";

// Started by the engine for each run. ASSISTENTE_SOCKET and ASSISTENTE_SECRET
// come from the app; without them every request is refused.
const socketPath = process.env.ASSISTENTE_SOCKET ?? "";
const secret = process.env.ASSISTENTE_SECRET ?? "";
const refuse = async () => ({ allow: false as const, reason: "O app do assistente não está ligado." });
const asker = socketPath && secret ? connectBridge(socketPath, secret) : { approve: refuse, confirmPlan: refuse };
await createAppMcpServer(asker).connect(new StdioServerTransport());
