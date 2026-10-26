// The voices the app offers, measured in bench/tts. The id becomes the `voz`
// arguments: "engine" or "engine:voice".

export interface VoiceOption {
  id: string;
  label: string;
  /** One line for the tooltip: what it costs. */
  note: string;
}

export const VOICES: VoiceOption[] = [
  { id: "apple", label: "macOS (Luciana)", note: "Sem download e instantânea; a mais robótica." },
  { id: "supertonic:F1", label: "Supertonic · feminina", note: "Neural; baixa 165 MB na primeira vez, usa ~150 MB." },
  { id: "supertonic:M1", label: "Supertonic · masculina", note: "Neural; baixa 165 MB na primeira vez, usa ~100 MB." },
  { id: "pocket:alba", label: "PocketTTS · Alba", note: "Neural; baixa 530 MB na primeira vez, usa ~700 MB." },
];

export const DEFAULT_VOICE = "apple";

/** `voz` arguments for a voice id; unknown ids fall back to the macOS voice. */
export function vozArgs(id: string): string[] {
  const known = VOICES.find((v) => v.id === id) ?? VOICES[0]!;
  const [engine, voice] = known.id.split(":");
  return voice ? ["--tts", engine!, "--tts-voice", voice] : ["--tts", engine!];
}
