import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// An app opened from the Finder does not get the terminal's PATH, so `claude`
// (often in ~/.local/bin) would not be found. Ask the person's login shell,
// then try the usual install places. ANI_CLAUDE_PATH overrides everything.

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function fromLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) =>
    execFile(shell, ["-l", "-c", "command -v claude"], { timeout: 10_000 }, (error, stdout) => {
      const path = stdout.trim().split("\n").at(-1) ?? "";
      resolve(!error && path.startsWith("/") && executable(path) ? path : null);
    }),
  );
}

export async function findClaude(): Promise<string> {
  const override = process.env.ANI_CLAUDE_PATH;
  if (override && executable(override)) return override;
  const found = await fromLoginShell();
  if (found) return found;
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find(executable) ?? "claude";
}
