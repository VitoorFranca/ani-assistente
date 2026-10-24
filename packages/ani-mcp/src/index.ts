#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAniMcpServer } from "./server.js";

// ani-mcp: the ANI-9 as an MCP server over stdio.
//   ANI_TOKEN  personal access token (ANI-9 → Configurações → Integrações)
//   ANI_URL    the ANI-9 address (default https://www.ani9.online)
// Logs go to stderr: stdout carries the MCP protocol.

const token = process.env.ANI_TOKEN?.trim();
if (!token) {
  console.error("ani-mcp: defina ANI_TOKEN com um token de acesso do ANI-9 (Configurações → Integrações).");
  process.exit(1);
}
const baseUrl = process.env.ANI_URL?.trim() || "https://www.ani9.online";

const server = createAniMcpServer({ baseUrl, token });
await server.connect(new StdioServerTransport());
console.error(`ani-mcp conectado a ${baseUrl}`);
