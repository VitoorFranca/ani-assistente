#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests: replays a recorded run and records its arguments.
// With --input-format stream-json it stays alive and answers each message from stdin.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS) {
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGS,
    JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + "\n",
  );
}
const recorded = readFileSync(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n");
const [init, ...turn] = recorded;

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
} else if (args.includes("--input-format")) {
  console.log(init);
  let n = 0;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    n++;
    if (process.env.FAKE_CLAUDE_INPUTS) appendFileSync(process.env.FAKE_CLAUDE_INPUTS, `${message.message.content}\n`);
    if (message.message.content === "pendura") return; // never answers: tests interruption
    for (const l of turn)
      console.log(l.includes('"type": "result"') ? l.replace('"num_turns": 2', `"num_turns": ${n}`) : l);
  });
} else {
  process.stdout.write(recorded.join("\n") + "\n");
}
