import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// The app side of the `voz` helper (native/voz): start it once, then ask it
// to listen or speak. One request at a time for each.

export type VoiceEvent =
  | { type: "ready"; loadMs: number }
  | { type: "listening" }
  | { type: "level"; rms: number }
  | { type: "speechStart" }
  | { type: "heard"; text: string; speechMs: number; asrMs: number }
  | { type: "nothing" }
  | { type: "spoken"; cancelled?: boolean }
  | { type: "error"; message: string; fatal?: boolean };

export interface VoiceOptions {
  binary: string;
  modelsDir: string;
  asr: "ultra" | "v3";
  onEvent?: (event: VoiceEvent) => void;
}

export function createVoice(options: VoiceOptions) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  const waiters = new Set<(event: VoiceEvent) => boolean>();

  function start(): Promise<void> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      child = spawn(options.binary, ["--asr", options.asr, "--models-dir", options.modelsDir], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", (error) => reject(error));
      child.on("exit", () => {
        child = null;
        ready = null;
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let event: VoiceEvent;
        try {
          event = JSON.parse(line) as VoiceEvent;
        } catch {
          return;
        }
        if (event.type === "ready") resolve();
        if (event.type === "error" && event.fatal) reject(new Error(event.message));
        options.onEvent?.(event);
        for (const waiter of [...waiters]) if (waiter(event)) waiters.delete(waiter);
      });
    });
    return ready;
  }

  function command(payload: Record<string, unknown>) {
    child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function until<T>(match: (event: VoiceEvent) => T | undefined): Promise<T> {
    return new Promise((resolve) => {
      waiters.add((event) => {
        const value = match(event);
        if (value === undefined) return false;
        resolve(value);
        return true;
      });
    });
  }

  return {
    start,
    /** Listens until the end of speech; null when nothing was said or it was cancelled. */
    async listen(file?: string): Promise<string | null> {
      await start();
      const result = until((e) =>
        e.type === "heard" ? e.text : e.type === "nothing" ? null : e.type === "error" && !e.fatal ? null : undefined,
      );
      command(file ? { cmd: "listenFile", path: file } : { cmd: "listen" });
      return result;
    },
    cancel: () => command({ cmd: "cancel" }),
    async speak(text: string): Promise<void> {
      if (!text.trim()) return;
      await start();
      const done = until((e) => (e.type === "spoken" ? true : undefined));
      command({ cmd: "speak", text });
      await done;
    },
    stopSpeaking: () => command({ cmd: "stopSpeaking" }),
    stop() {
      child?.stdin.end();
      child?.kill();
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;

/** "sim", "pode", "claro" → true; "não", "cancela" → false; anything else → null (ask again). */
export function yesOrNo(text: string): boolean | null {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .trim();
  if (/^(nao|cancela|cancelar|para|pare|espera|negativo|deixa|melhor nao|agora nao)\b/.test(t)) return false;
  if (
    /^(sim|pode|claro|ok|okay|isso|confirmo|confirma|manda|vai|faz|beleza|com certeza|positivo|continua|segue)\b/.test(
      t,
    )
  )
    return true;
  return null;
}
