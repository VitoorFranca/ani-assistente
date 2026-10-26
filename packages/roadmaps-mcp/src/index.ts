#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_REPO } from "./catalog.js";
import { createRoadmapsMcpServer } from "./server.js";

// roadmaps-mcp: the ANI-9's public roadmap catalog as an MCP server over stdio.
//   ROADMAPS_DIR   where the local clone lives (default ~/.ani-assistente/roadmaps)
//   ROADMAPS_REPO  owner/name on GitHub (default VitoorFranca/ani9-roadmaps)
// Needs git and, to open pull requests, the gh CLI signed in by the person.
// Logs go to stderr: stdout carries the MCP protocol.

const dir = process.env.ROADMAPS_DIR?.trim() || join(homedir(), ".ani-assistente", "roadmaps");
const repo = process.env.ROADMAPS_REPO?.trim() || DEFAULT_REPO;

const server = createRoadmapsMcpServer({ dir, repo });
await server.connect(new StdioServerTransport());
console.error(`roadmaps-mcp: catálogo ${repo} em ${dir}`);
