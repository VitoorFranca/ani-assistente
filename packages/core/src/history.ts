import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunHistory, RunRecord } from "./estimate.js";

/** Run history as one JSON line per run, in the app's data folder. Only counts, never content. */
export function createFileHistory(path: string, keep = 500): RunHistory {
  return {
    async load() {
      try {
        const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
        return lines.slice(-keep).flatMap((line) => {
          try {
            return [JSON.parse(line) as RunRecord];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
    async append(record) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  };
}

export function createMemoryHistory(initial: RunRecord[] = []): RunHistory & { records: RunRecord[] } {
  const records = [...initial];
  return { records, load: async () => [...records], append: async (r) => void records.push(r) };
}
