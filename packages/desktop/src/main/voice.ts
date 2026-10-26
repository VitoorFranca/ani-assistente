import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { spokenText } from "./spoken.js";

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
  | { type: "overheard"; text: string }
  | { type: "error"; message: string; fatal?: boolean };

export interface VoiceOptions {
  binary: string;
  modelsDir: string;
  asr: "ultra" | "v3";
  /** Extra `voz` arguments for the voice that answers (voices.ts). */
  ttsArgs?: string[];
  onEvent?: (event: VoiceEvent) => void;
  /** Tests only: the wake-word mode reads this WAV instead of the microphone. */
  testWakeFile?: string;
  /** Tests only: nothing is played; every sentence counts as spoken at once. */
  mute?: boolean;
}

export function createVoice(options: VoiceOptions) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  const waiters = new Set<(event: VoiceEvent) => boolean>();

  function start(): Promise<void> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      child = spawn(
        options.binary,
        ["--asr", options.asr, "--models-dir", options.modelsDir, ...(options.ttsArgs ?? [])],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
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
    /** Wake-word mode: short utterances come back as "overheard" events. */
    async watch(on: boolean) {
      await start();
      if (options.testWakeFile) {
        if (on) command({ cmd: "watchFile", path: options.testWakeFile });
      } else command({ cmd: "watch", on });
    },
    async speak(text: string): Promise<void> {
      if (!text.trim() || options.mute) return;
      await start();
      const done = until((e) => (e.type === "spoken" ? true : undefined));
      command({ cmd: "speak", text: spokenText(text) });
      await done;
    },
    /**
     * Streams speech: say() queues a sentence (the synthesizer plays them in
     * order) and finished() resolves when every queued sentence was spoken.
     */
    speaker() {
      let queued = 0;
      let spoken = 0;
      let wake: (() => void) | null = null;
      const listener = (event: VoiceEvent) => {
        if (event.type !== "spoken") return false;
        spoken++;
        if (spoken >= queued) wake?.();
        return false; // keep listening
      };
      waiters.add(listener);
      return {
        async say(sentence: string) {
          if (!sentence.trim()) return;
          await start();
          queued++;
          if (options.mute) {
            options.onEvent?.({ type: "spoken" });
            listener({ type: "spoken" });
          } else command({ cmd: "speak", text: spokenText(sentence) });
        },
        async finished() {
          if (spoken < queued) await new Promise<void>((resolve) => (wake = resolve));
          waiters.delete(listener);
        },
        stop() {
          waiters.delete(listener);
          command({ cmd: "stopSpeaking" });
        },
      };
    },
    stopSpeaking: () => command({ cmd: "stopSpeaking" }),
    stop() {
      child?.stdin.end();
      child?.kill();
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;

/**
 * Cuts finished sentences off streamed text: returns the sentences ready to
 * speak and the rest still being written. Short pieces wait for more text,
 * so the voice does not stutter on "Ok." or numbers like "3.5".
 */
export function takeSentences(buffer: string, minLength = 24): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(/^([\s\S]*?[.!?…:;])(\s+|$)|^([\s\S]*?)\n+/);
    if (!match || (match[2] === "" && match[1] !== undefined)) break; // the end may still grow
    const sentence = (match[1] ?? match[3] ?? "").trim();
    if (sentence.length < minLength && match[1] !== undefined) {
      // Too short to speak alone: join it with the next one.
      const next = rest.slice(match[0].length).match(/^([\s\S]*?[.!?…:;])(\s+)/);
      if (!next) break;
      ready.push(`${sentence} ${next[1]!.trim()}`);
      rest = rest.slice(match[0].length + next[0].length);
      continue;
    }
    if (sentence) ready.push(sentence);
    rest = rest.slice(match[0].length);
  }
  return { ready, rest };
}

const letters = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}]/gu, "");

/**
 * "Ei, Ani" as the speech model tends to write it: "Eiane", "Oiani", "Ani,",
 * "Annie". The first one or two words, joined, must sound like an optional
 * greeting plus "Ani"; "Ana" and ordinary sentences do not wake it.
 */
const WAKE = /^(?:e[iy]|o[iy]|h?ey|ai)?(?:a|ha)?nn?(?:i|e|y|ie)$/;

export function wakeRequest(text: string): { woke: boolean; rest: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const count of [1, 2]) {
    if (words.length < count) break;
    if (WAKE.test(letters(words.slice(0, count).join("")))) {
      const rest = words
        .slice(count)
        .join(" ")
        .replace(/^[\s,.;:!?…-]+/, "")
        .trim();
      return { woke: true, rest };
    }
  }
  return { woke: false, rest: "" };
}

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
