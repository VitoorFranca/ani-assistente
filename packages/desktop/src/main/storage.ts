import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AssistantSettings } from "@ani-assistente/core";

// What the app keeps in its data folder: settings (plain JSON) and the ANI-9
// token, encrypted with safeStorage (a key kept in the macOS Keychain).

export interface AppSettings {
  aniUrl: string;
  assistant: AssistantSettings;
  /** Global shortcut that opens the assistant (and starts listening when voice is on). */
  shortcut: string;
  voice: { enabled: boolean; asr: "ultra" | "v3" };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  aniUrl: "https://www.ani9.online",
  assistant: DEFAULT_SETTINGS,
  shortcut: "Alt+Space",
  voice: { enabled: true, asr: "ultra" },
};

const dir = () => {
  const path = app.getPath("userData");
  mkdirSync(path, { recursive: true });
  return path;
};
const settingsPath = () => join(dir(), "settings.json");
const tokenPath = () => join(dir(), "ani-token.bin");

export function loadSettings(): AppSettings {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<AppSettings>;
    return {
      ...DEFAULT_APP_SETTINGS,
      ...saved,
      voice: { ...DEFAULT_APP_SETTINGS.voice, ...saved.voice },
      assistant: {
        ...DEFAULT_SETTINGS,
        ...saved.assistant,
        models: { ...DEFAULT_SETTINGS.models, ...saved.assistant?.models },
        budgets: { ...DEFAULT_SETTINGS.budgets, ...saved.assistant?.budgets },
      },
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function loadToken(): string | null {
  if (!existsSync(tokenPath()) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(tokenPath()));
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  if (!token) return rmSync(tokenPath(), { force: true });
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("As Chaves do macOS não estão disponíveis para guardar o token.");
  writeFileSync(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 });
}

export const historyPath = () => join(dir(), "runs.jsonl");
export const voiceModelsPath = () => join(dir(), "models");
