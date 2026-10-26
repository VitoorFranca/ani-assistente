import type { ToMain, ToRenderer } from "../main/protocol.js";

// The panel: a conversation, the questions only the person can answer, and
// the setup (Claude Code login, ANI-9 token) and settings. No framework.

declare global {
  interface Window {
    ani: {
      send(message: ToMain): void;
      on(listener: (message: ToRenderer) => void): void;
      onFocus(listener: () => void): void;
    };
  }
}

type Status = Extract<ToRenderer, { type: "status" }>;
type Question = Extract<ToRenderer, { type: "question" }>;
interface Turn {
  role: "pessoa" | "ani";
  text: string;
  meta?: string;
  tools: string[];
  error?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  ani_conta: "conferindo a conta",
  ani_resumo_do_dia: "vendo o dia",
  ani_estatisticas: "lendo estatísticas",
  ani_listar_baralhos: "listando baralhos",
  ani_buscar_cartoes: "buscando cartões",
  ani_criar_nota: "criando cartão",
  ani_listar_cadernos: "listando cadernos",
  ani_ler_caderno: "abrindo caderno",
  ani_ler_folha: "lendo folha",
  ani_criar_caderno: "criando caderno",
  ani_criar_folha: "criando folha",
  ani_anotar_na_folha: "anotando",
  ani_listar_roadmaps: "listando roadmaps",
  ani_ler_roadmap: "lendo roadmap",
  ani_marcar_progresso_roadmap: "marcando progresso",
  ani_listar_tarefas: "vendo tarefas",
  ani_adicionar_tarefa: "anotando tarefa",
  ani_concluir_tarefa: "concluindo tarefa",
  confirmar_plano: "planejando",
};

const state = {
  status: null as Status | null,
  view: "chat" as "chat" | "ajustes",
  turns: [] as Turn[],
  busy: false,
  usage: 0,
  question: null as Question | null,
  draft: "",
  tokenDraft: "",
  notice: "",
  voice: { state: "off", level: 0, detail: "" } as { state: string; level: number; detail: string },
};

const VOICE_LABEL: Record<string, string> = {
  loading: "Carregando a voz…",
  listening: "Ouvindo…",
  hearing: "Ouvindo…",
  speaking: "Falando…",
};

const root = document.getElementById("app")!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function")
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === "class") el.className = String(value);
    else if (key in el && key !== "list") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const send = (message: ToMain) => window.ani.send(message);
const k = (n: number) => `${Math.max(1, Math.round(n / 1000))} mil`;

function ready(status: Status | null): boolean {
  return Boolean(status?.engine.installed && status.engine.loggedIn && status.ani.connected);
}

function limitsLine(status: Status | null): string {
  if (!status?.limits.length) return "";
  return status.limits.map((w) => `${w.name}: ${Math.round(w.utilization * 100)}%`).join(" · ");
}

function submit() {
  const text = state.draft.trim();
  if (!text || state.busy) return;
  state.turns.push({ role: "pessoa", text, tools: [] });
  state.turns.push({ role: "ani", text: "", tools: [] });
  state.draft = "";
  state.busy = true;
  state.usage = 0;
  send({ type: "ask", text });
  render();
}

function answer(yes: boolean) {
  if (!state.question) return;
  send({ type: "answer", id: state.question.id, yes });
}

function header() {
  const s = state.status;
  const ok = ready(s);
  return h(
    "header",
    { class: "top" },
    h("span", { class: "brand" }, "Ani"),
    h("span", { class: `dot ${ok ? "is-ok" : "is-off"}`, title: ok ? "Pronta" : "Falta configurar" }),
    h("span", { class: "spacer" }),
    state.view === "chat" &&
      h(
        "button",
        {
          class: "icon",
          title: "Nova conversa",
          onclick: () => ((state.turns = []), send({ type: "reset" }), render()),
        },
        "↺",
      ),
    h(
      "button",
      {
        class: "icon",
        title: state.view === "chat" ? "Ajustes" : "Voltar",
        onclick: () => ((state.view = state.view === "chat" ? "ajustes" : "chat"), render()),
      },
      state.view === "chat" ? "⚙" : "✕",
    ),
  );
}

function setup(status: Status | null) {
  const engineOk = status?.engine.installed && status.engine.loggedIn;
  return h(
    "section",
    { class: "setup" },
    h("h1", {}, "Vamos começar"),
    h(
      "p",
      { class: "muted" },
      "A Ani usa a sua própria assinatura de IA e a sua conta do ANI-9. Nada passa por terceiros.",
    ),
    h(
      "div",
      { class: `step ${engineOk ? "is-done" : ""}` },
      h("strong", {}, "1. Claude Code"),
      !status
        ? h("p", { class: "muted" }, "Verificando…")
        : engineOk
          ? h("p", {}, `Conectado · plano ${status.engine.plan ?? "—"} · versão ${status.engine.version}`)
          : h(
              "div",
              {},
              h("p", {}, status.engine.hint ?? "Faça login no Claude Code."),
              status.engine.installed &&
                h("button", { class: "primary", onclick: () => send({ type: "login" }) }, "Fazer login no Terminal"),
              h("button", { class: "ghost", onclick: () => send({ type: "status" }) }, "Verificar de novo"),
            ),
    ),
    h(
      "div",
      { class: `step ${status?.ani.connected ? "is-done" : ""}` },
      h("strong", {}, "2. Conta do ANI-9"),
      status?.ani.connected
        ? h("p", {}, `Conectado como ${status.ani.account}`)
        : h(
            "div",
            {},
            h("p", {}, "Gere um token em Configurações → Integrações → Tokens de acesso, e cole aqui."),
            status?.ani.error && h("p", { class: "error" }, status.ani.error),
            h("input", {
              type: "password",
              placeholder: "ani9_…",
              value: state.tokenDraft,
              oninput: (e: Event) => (state.tokenDraft = (e.target as HTMLInputElement).value.trim()),
            }),
            h(
              "button",
              {
                class: "primary",
                onclick: () => {
                  try {
                    send({ type: "saveToken", token: state.tokenDraft });
                    state.tokenDraft = "";
                    state.notice = "";
                  } catch (error) {
                    state.notice = error instanceof Error ? error.message : "Token inválido.";
                  }
                  render();
                },
              },
              "Salvar token",
            ),
            state.notice && h("p", { class: "error" }, state.notice),
          ),
    ),
  );
}

function questionCard(question: Question) {
  return h(
    "div",
    { class: `question is-${question.kind}`, role: "alertdialog" },
    h("p", {}, question.text),
    question.steps && question.steps.length > 0 && h("ol", {}, ...question.steps.map((step) => h("li", {}, step))),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "ghost", onclick: () => answer(false) }, "Não"),
      h(
        "button",
        { class: "primary", onclick: () => answer(true), autofocus: true },
        question.kind === "budget" ? "Continuar" : "Sim",
      ),
    ),
  );
}

function chat() {
  const list = h(
    "div",
    { class: "turns" },
    !state.turns.length &&
      h(
        "div",
        { class: "empty" },
        h("p", {}, "Pergunte sobre o seu estudo ou peça uma ação."),
        h("p", { class: "muted" }, "“Quantas revisões eu tenho hoje?” · “Anota a tarefa de revisar Fisiologia”"),
      ),
    ...state.turns.map((turn, i) =>
      h(
        "div",
        { class: `turn is-${turn.role}${turn.error ? " is-error" : ""}` },
        turn.tools.length > 0 && h("p", { class: "tools" }, turn.tools.map((t) => TOOL_LABELS[t] ?? t).join(" · ")),
        h("p", { class: "text" }, turn.text || (state.busy && i === state.turns.length - 1 ? "…" : "")),
        turn.meta && h("p", { class: "meta" }, turn.meta),
      ),
    ),
    state.question && questionCard(state.question),
  );
  const input = h("textarea", {
    rows: 2,
    placeholder: "Fale com a Ani…",
    value: state.draft,
    oninput: (e: Event) => (state.draft = (e.target as HTMLTextAreaElement).value),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
  });
  const voiceOn = Boolean(state.status?.voice.enabled && state.status.voice.available);
  const listening = state.voice.state === "listening" || state.voice.state === "hearing";
  const composer = h(
    "footer",
    { class: "composer" },
    voiceOn &&
      h(
        "button",
        {
          class: `mic${listening ? " is-on" : ""}`,
          title: "Falar (⌥Espaço)",
          disabled: state.voice.state === "loading" || state.voice.state === "off",
          onclick: () => send({ type: "listen" }),
        },
        "●",
      ),
    input,
    state.busy
      ? h("button", { class: "ghost", onclick: () => send({ type: "stop" }) }, "Parar")
      : h("button", { class: "primary", onclick: submit, disabled: !state.draft.trim() }, "Enviar"),
  );
  const line = [
    VOICE_LABEL[state.voice.state] ?? "",
    state.voice.detail && state.voice.state !== "idle" ? state.voice.detail : "",
    state.busy && state.usage ? `${k(state.usage)} tokens` : "",
    limitsLine(state.status),
  ]
    .filter(Boolean)
    .join(" · ");
  // CSSOM, not an inline style attribute: the panel's CSP allows only its own stylesheet.
  composer
    .querySelector<HTMLElement>(".mic")
    ?.style.setProperty("--level", listening ? state.voice.level.toFixed(2) : "0");
  queueMicrotask(() => {
    list.scrollTop = list.scrollHeight;
    if (!state.question) input.focus();
  });
  return h("main", { class: "chat" }, list, line && h("p", { class: "limits" }, line), composer);
}

function settingsView(status: Status | null) {
  if (!status) return h("p", { class: "muted pad" }, "Carregando…");
  const select = (value: string, onchange: (v: string) => void) =>
    h(
      "select",
      { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
      ...status.models.map((m) => h("option", { value: m.id, selected: m.id === value, title: m.note }, m.label)),
    );
  const budget = (value: number, onchange: (v: number) => void) =>
    h("input", {
      type: "number",
      min: 5,
      max: 2000,
      step: 5,
      value: Math.round(value / 1000),
      onchange: (e: Event) => onchange(Number((e.target as HTMLInputElement).value) * 1000),
    });
  return h(
    "section",
    { class: "settings" },
    h("h1", {}, "Ajustes"),
    h(
      "div",
      { class: "row" },
      h("span", {}, "Modelo para perguntas rápidas"),
      select(status.settings.quickModel, (v) => send({ type: "saveSettings", quickModel: v })),
    ),
    h(
      "div",
      { class: "row" },
      h("span", {}, "Modelo para tarefas"),
      select(status.settings.taskModel, (v) => send({ type: "saveSettings", taskModel: v })),
    ),
    h(
      "div",
      { class: "row" },
      h("span", { title: "Ao passar disso, a Ani para e pergunta se continua." }, "Limite por pergunta (mil tokens)"),
      budget(status.settings.quickBudget, (v) => send({ type: "saveSettings", quickBudget: v })),
    ),
    h(
      "div",
      { class: "row" },
      h("span", { title: "Ao passar disso, a Ani para e pergunta se continua." }, "Limite por tarefa (mil tokens)"),
      budget(status.settings.taskBudget, (v) => send({ type: "saveSettings", taskBudget: v })),
    ),
    h("p", { class: "muted" }, "Diga “usa o Opus nisso” para trocar o modelo só naquele pedido."),
    h(
      "div",
      { class: "row" },
      h("span", { title: "⌥Espaço começa a ouvir; a Ani responde e confirma por voz." }, "Voz"),
      status.voice.available
        ? h("input", {
            type: "checkbox",
            checked: status.voice.enabled,
            onchange: (e: Event) => send({ type: "saveVoice", enabled: (e.target as HTMLInputElement).checked }),
          })
        : h("span", { class: "muted" }, "componente de voz não encontrado"),
    ),
    status.voice.available &&
      status.voice.enabled &&
      h(
        "div",
        { class: "row" },
        h(
          "span",
          { title: "A voz que responde. As neurais soam mais naturais e baixam o modelo na primeira vez." },
          "Voz da Ani",
        ),
        h(
          "select",
          { onchange: (e: Event) => send({ type: "saveVoice", tts: (e.target as HTMLSelectElement).value }) },
          ...status.voice.voices.map((v) =>
            h("option", { value: v.id, selected: v.id === status.voice.tts, title: v.note }, v.label),
          ),
        ),
      ),
    status.voice.available &&
      status.voice.enabled &&
      h(
        "div",
        { class: "row" },
        h(
          "span",
          {
            title: "O microfone fica aberto para ouvir “Ei, Ani”. Tudo acontece neste Mac: nada é gravado nem enviado.",
          },
          "“Ei, Ani”",
        ),
        h("input", {
          type: "checkbox",
          checked: status.voice.wake,
          onchange: (e: Event) => send({ type: "saveVoice", wake: (e.target as HTMLInputElement).checked }),
        }),
      ),
    status.voice.wake &&
      h("p", { class: "muted" }, "O microfone fica aberto para ouvir “Ei, Ani”. Nada sai deste Mac."),
    h("h2", {}, "Conexões"),
    h("p", {}, `${status.engine.label}: ${status.engine.loggedIn ? `conectado · ${status.engine.plan}` : "sem login"}`),
    h("p", {}, `ANI-9: ${status.ani.connected ? status.ani.account : "não conectado"} · ${status.ani.url}`),
    status.ani.connected &&
      h("button", { class: "ghost", onclick: () => send({ type: "forgetToken" }) }, "Desconectar o ANI-9"),
    limitsLine(status) && h("p", { class: "muted" }, `Uso da assinatura: ${limitsLine(status)}`),
  );
}

function render() {
  const s = state.status;
  root.replaceChildren(header(), state.view === "ajustes" ? settingsView(s) : ready(s) ? chat() : setup(s));
}

function current(): Turn | undefined {
  return state.turns.at(-1)?.role === "ani" ? state.turns.at(-1) : undefined;
}

window.ani.on((message) => {
  const turn = current();
  switch (message.type) {
    case "status":
      state.status = message;
      break;
    case "routed":
      if (turn) turn.meta = message.model;
      break;
    case "text":
      if (turn) turn.text += message.delta;
      break;
    case "tool":
      if (turn && !turn.tools.includes(message.name)) turn.tools.push(message.name);
      break;
    case "usage":
      state.usage = message.tokens;
      break;
    case "limits":
      if (state.status) state.status = { ...state.status, limits: message.windows };
      break;
    case "done":
      if (turn) {
        turn.text = message.text || turn.text;
        turn.meta = `${turn.meta ?? ""} · ${k(message.tokens)} tokens · ${message.seconds.toFixed(1)} s`;
      }
      state.busy = false;
      break;
    case "error":
      if (turn && state.busy) {
        turn.text = message.message;
        turn.error = true;
      } else state.turns.push({ role: "ani", text: message.message, tools: [], error: true });
      state.busy = false;
      break;
    case "stopped":
      if (turn) turn.text = `${turn.text}\n${message.reason}`.trim();
      state.busy = false;
      break;
    case "question":
      state.question = message;
      break;
    case "questionClosed":
      if (state.question?.id === message.id) state.question = null;
      break;
    case "voice":
      state.voice = { state: message.state, level: message.level ?? 0, detail: message.detail ?? "" };
      break;
    case "heard":
      state.turns.push({ role: "pessoa", text: message.text, tools: [] });
      state.turns.push({ role: "ani", text: "", tools: [] });
      state.busy = true;
      state.usage = 0;
      break;
  }
  render();
});

window.ani.onFocus(() => {
  send({ type: "status" });
  render();
});

document.addEventListener("keydown", (e) => {
  // Shortcuts only outside text fields: a letter typed in a sentence must never answer a question.
  if (!state.question || (e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))) return;
  if (e.key === "s" || e.key === "S") answer(true);
  if (e.key === "n" || e.key === "N" || e.key === "Escape") answer(false);
});

render();
send({ type: "status" });
