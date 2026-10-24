#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests: replays a recorded run and records its arguments.
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS) {
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGS,
    JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + "\n",
  );
}
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
} else if (args[0] === "auth") {
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
      email: "nao-deve-vazar@example.com",
    }),
  );
} else if (process.env.FAKE_CLAUDE_FAIL) {
  console.error("Error: Please log in to continue.");
  process.exit(1);
} else {
  process.stdout.write(readFileSync(new URL("./fixtures/claude-stream.jsonl", import.meta.url)));
}
