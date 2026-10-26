import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, Tray, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAssistant, createFileHistory, type Assistant } from "@ani-assistente/core";
import { createClaudeCodeEngine, totalTokens, type LimitWindow } from "@ani-assistente/engines";
import { toMain, toRenderer, type ToRenderer } from "./protocol.js";
import {
  historyPath,
  loadSettings,
  loadToken,
  saveSettings,
  saveToken,
  voiceModelsPath,
  type AppSettings,
} from "./storage.js";
import { createVoice, yesOrNo, type Voice } from "./voice.js";
import { findClaude } from "./claudePath.js";

// The menu bar app: an icon, a global shortcut and a small panel. The
// assistant core runs here, in the main process; the panel only shows and asks.

// Tests and development can keep their data apart from the installed app.
if (process.env.ANI_ASSISTENTE_DATA) app.setPath("userData", process.env.ANI_ASSISTENTE_DATA);
app.setName("Ani");

const here = __dirname;
// The MCP servers run as separate processes, so the packaged app keeps them outside the asar archive.
const mcpDir = join(here, "mcp").replace("app.asar/", "app.asar.unpacked/");
const MCP = { ani: join(mcpDir, "ani.mjs"), app: join(mcpDir, "app.mjs") };
/** The voice helper (native/voz): bundled with the app, or built in the repository during development. */
const VOZ = app.isPackaged
  ? join(process.resourcesPath, "bin", "voz")
  : join(here, "..", "..", "..", "native", "voz", ".build", "release", "voz");

/** Opens a command in the person's Terminal (for Claude Code's own login). */
function openTerminal(command: string): Promise<void> {
  const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", script], (error) => (error ? reject(error) : resolve())),
  );
}

let engine = createClaudeCodeEngine({ openTerminal });
let settings: AppSettings;
let assistant: Assistant | null = null;
let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let running: AbortController | null = null;
let lastLimits: LimitWindow[] = [];
let voice: Voice | null = null;
/** The current request came by voice: answer and confirm by voice too. */
let voiceTurn = false;
const questions = new Map<number, (yes: boolean) => void>();
let nextQuestion = 1;

function send(message: ToRenderer) {
  // Validated on the way out too: a bug here must not reach the window with an odd shape.
  const parsed = toRenderer.safeParse(message);
  if (parsed.success) panel?.webContents.send("ani", parsed.data);
}

function ask(kind: "action" | "plan" | "budget", text: string, steps?: string[]): Promise<boolean> {
  const id = nextQuestion++;
  showPanel();
  send({ type: "question", id, kind, text, steps });
  const answered = new Promise<boolean>((resolve) =>
    questions.set(id, (yes) => {
      questions.delete(id);
      send({ type: "questionClosed", id });
      if (voiceTurn) voice?.cancel(); // answered by click: stop listening for "sim/não"
      resolve(yes);
    }),
  );
  if (voiceTurn && voice) void askByVoice(id, text);
  return answered;
}

/** Says the question and listens for yes or no; a click on the panel answers first if it comes first. */
async function askByVoice(id: number, text: string) {
  if (!voice) return;
  send({ type: "voice", state: "speaking" });
  await voice.speak(text);
  for (let attempt = 0; attempt < 2 && questions.has(id); attempt++) {
    send({ type: "voice", state: "listening" });
    const heard = await voice.listen();
    if (!questions.has(id)) break;
    const yes = heard ? yesOrNo(heard) : null;
    if (yes !== null) {
      questions.get(id)?.(yes);
      break;
    }
    if (attempt === 0) {
      send({ type: "voice", state: "speaking" });
      await voice.speak("Não entendi. Responda sim ou não.");
    }
  }
  send({ type: "voice", state: "idle" });
}

async function aniAccount(token: string): Promise<{ account: string | null; error: string | null }> {
  try {
    const response = await fetch(`${settings.aniUrl.replace(/\/+$/, "")}/api/account`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { account: null, error: "Token recusado pelo ANI-9. Gere outro." };
    if (!response.ok) return { account: null, error: `O ANI-9 respondeu ${response.status}.` };
    return { account: ((await response.json()) as { email: string }).email, error: null };
  } catch {
    return { account: null, error: "Não consegui falar com o ANI-9." };
  }
}

async function rebuildAssistant() {
  await assistant?.close();
  assistant = null;
  const token = loadToken();
  if (!token) return;
  assistant = await createAssistant({
    engine,
    ani: { url: settings.aniUrl, token },
    servers: { runtime: process.execPath, runtimeEnv: { ELECTRON_RUN_AS_NODE: "1" }, aniMcp: MCP.ani, appMcp: MCP.app },
    prompts: {
      confirmAction: (question) => ask("action", question),
      confirmPlan: ({ question, steps }) => ask("plan", question, steps),
      continueOverBudget: ({ question }) => ask("budget", question),
    },
    history: createFileHistory(historyPath()),
    settings: settings.assistant,
  });
}

async function sendStatus() {
  const [engineStatus, ani] = await Promise.all([
    engine.status(),
    (async () => {
      const token = loadToken();
      return token ? aniAccount(token) : { account: null, error: null };
    })(),
  ]);
  send({
    type: "status",
    engine: { label: engine.label, ...engineStatus },
    ani: { connected: Boolean(ani.account), account: ani.account, url: settings.aniUrl, error: ani.error },
    models: engine.models(),
    settings: {
      quickModel: settings.assistant.models.rapido,
      taskModel: settings.assistant.models.tarefa,
      quickBudget: settings.assistant.budgets.rapido,
      taskBudget: settings.assistant.budgets.tarefa,
    },
    limits: lastLimits.map((w) => ({ ...w, resetsAt: w.resetsAt?.toISOString() ?? null })),
    voice: { enabled: settings.voice.enabled, available: existsSync(VOZ) },
  });
}

async function runRequest(text: string) {
  if (!assistant) return send({ type: "error", message: "Conecte o ANI-9 primeiro (token em Ajustes)." });
  running?.abort();
  const controller = new AbortController();
  running = controller;
  const started = Date.now();
  try {
    for await (const event of assistant.ask(text, controller.signal)) {
      switch (event.type) {
        case "routed":
          send({ type: "routed", kind: event.kind, model: event.model });
          break;
        case "text":
          send({ type: "text", delta: event.delta });
          break;
        case "tool":
          send({ type: "tool", name: event.name.split("__").at(-1) ?? event.name });
          break;
        case "usage":
          send({ type: "usage", tokens: totalTokens(event.usage) });
          break;
        case "limits":
          lastLimits = event.windows;
          send({
            type: "limits",
            windows: event.windows.map((w) => ({ ...w, resetsAt: w.resetsAt?.toISOString() ?? null })),
          });
          break;
        case "done":
          send({
            type: "done",
            text: event.text,
            tokens: totalTokens(event.usage),
            seconds: (Date.now() - started) / 1000,
          });
          if (voiceTurn && voice && event.text) {
            send({ type: "voice", state: "speaking" });
            void voice.speak(event.text).then(() => send({ type: "voice", state: "idle" }));
          }
          break;
        case "error":
          if (event.kind !== "aborted") send({ type: "error", message: event.message });
          break;
        case "stopped":
          send({ type: "stopped", reason: event.reason });
          break;
      }
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Algo deu errado." });
  } finally {
    if (running === controller) running = null;
  }
}

/** Shortcut or microphone button: stop talking if speaking, else listen and send what was heard. */
async function listenAndAsk() {
  if (!voice || !settings.voice.enabled) return;
  showPanel();
  if (questions.size) return; // a question is waiting: it is listening already
  voice.stopSpeaking();
  if (running) return;
  send({ type: "voice", state: "listening" });
  const text = await voice.listen().catch(() => null);
  send({ type: "voice", state: "idle" });
  if (!text) return;
  voiceTurn = true;
  send({ type: "heard", text });
  await runRequest(text);
}

function startVoice() {
  voice?.stop();
  voice = null;
  if (!settings.voice.enabled || !existsSync(VOZ)) return;
  voice = createVoice({
    binary: VOZ,
    modelsDir: voiceModelsPath(),
    asr: settings.voice.asr,
    onEvent: (event) => {
      if (event.type === "level") send({ type: "voice", state: "listening", level: Math.min(1, event.rms * 12) });
      if (event.type === "speechStart") send({ type: "voice", state: "hearing" });
      if (event.type === "error") send({ type: "voice", state: "idle", detail: event.message });
    },
  });
  send({ type: "voice", state: "loading", detail: "Carregando a voz (na primeira vez, baixa o modelo de fala)…" });
  voice.start().then(
    () => send({ type: "voice", state: "idle" }),
    (error) =>
      send({ type: "voice", state: "off", detail: error instanceof Error ? error.message : "A voz não iniciou." }),
  );
}

function positionPanel() {
  if (!panel || !tray) return;
  const trayBounds = tray.getBounds();
  const { width, height } = panel.getBounds();
  const area = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;
  const x = Math.min(
    Math.max(Math.round(trayBounds.x + trayBounds.width / 2 - width / 2), area.x + 8),
    area.x + area.width - width - 8,
  );
  const y = trayBounds.height ? trayBounds.y + trayBounds.height + 6 : area.y + 6;
  panel.setBounds({ x, y, width, height });
}

function showPanel() {
  if (!panel) return;
  // Opening the panel warms the engine (no tokens are spent until a request is sent).
  assistant?.warm();
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.send("ani-focus");
}

function togglePanel() {
  if (panel?.isVisible() && panel.isFocused()) panel.hide();
  else showPanel();
}

function createPanel() {
  panel = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: "panel",
    backgroundColor: "#f6f2e7",
    webPreferences: {
      preload: join(here, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void panel.loadFile(join(here, "renderer", "index.html"));
  // Clicking elsewhere hides the panel, unless it is waiting for an answer.
  panel.on("blur", () => {
    if (!questions.size && !panel?.webContents.isDevToolsOpened()) panel?.hide();
  });
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.on("ani", (_event, raw: unknown) => {
  const parsed = toMain.safeParse(raw);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.type) {
    case "ask":
      voiceTurn = false;
      void runRequest(message.text);
      break;
    case "listen":
      void listenAndAsk();
      break;
    case "saveVoice":
      settings = { ...settings, voice: { ...settings.voice, enabled: message.enabled } };
      saveSettings(settings);
      startVoice();
      void sendStatus();
      break;
    case "stop":
      running?.abort();
      break;
    case "answer":
      questions.get(message.id)?.(message.yes);
      break;
    case "reset":
      assistant?.reset();
      break;
    case "status":
      void sendStatus();
      break;
    case "login":
      void engine.login().catch(() => send({ type: "error", message: "Abra o Terminal e rode: claude auth login" }));
      break;
    case "saveToken":
      saveToken(message.token);
      void rebuildAssistant().then(sendStatus);
      break;
    case "forgetToken":
      saveToken(null);
      void rebuildAssistant().then(sendStatus);
      break;
    case "saveSettings": {
      const a = settings.assistant;
      settings = {
        ...settings,
        aniUrl: message.aniUrl ?? settings.aniUrl,
        assistant: {
          ...a,
          models: { rapido: message.quickModel ?? a.models.rapido, tarefa: message.taskModel ?? a.models.tarefa },
          budgets: { rapido: message.quickBudget ?? a.budgets.rapido, tarefa: message.taskBudget ?? a.budgets.tarefa },
        },
      };
      saveSettings(settings);
      void rebuildAssistant().then(sendStatus);
      break;
    }
  }
});

app.whenReady().then(async () => {
  app.dock?.hide();
  settings = loadSettings();
  engine = createClaudeCodeEngine({ command: await findClaude(), openTerminal });
  createPanel();
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Ani");
  tray.setToolTip("Ani — assistente do ANI-9");
  tray.on("click", togglePanel);
  const onShortcut = () => (settings.voice.enabled && voice ? void listenAndAsk() : togglePanel());
  if (!globalShortcut.register(settings.shortcut, onShortcut)) {
    console.error(`Não consegui registrar o atalho ${settings.shortcut}.`);
  }
  await rebuildAssistant();
  startVoice();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  running?.abort();
  voice?.stop();
  void assistant?.close();
});

// A menu bar app keeps running without windows.
app.on("window-all-closed", () => {});
