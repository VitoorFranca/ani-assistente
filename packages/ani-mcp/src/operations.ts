import type { AniClient } from "./client.js";
import { clip, escapeHtml, fold, htmlToText, textToHtml } from "./text.js";

// What the assistant can do in the ANI-9. Every operation returns short,
// readable text (it may be spoken aloud) and never invents an item: names
// that match nothing or more than one thing come back as a question.

/** A name that matched nothing, or more than one thing: the agent should ask the person. */
export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

interface Deck {
  id: string;
  name: string;
  namePath: string;
  parentId: string | null;
  archived: boolean;
  totalCount: number;
  newCount: number;
  dueCount: number;
}
interface NotebookSummary {
  id: string;
  name: string;
  sheetCount: number;
  tags: string[];
}
interface Sheet {
  id: string;
  notebookId: string;
  title: string;
  html?: string;
}
interface RoadmapListItem {
  roadmap: { id: string; title: string; summary: string };
  role: string;
  total: number;
  done: number;
}
interface RoadmapNode {
  id: string;
  kind: "topic" | "subtopic";
  x: number;
  y: number;
  title: string;
  summary: string;
  progress: "estudando" | "feito" | null;
  resources: { kind: "teoria" | "pratica"; title: string; url: string }[];
}

const TASKS_NOTEBOOK = "Tarefas";
const TASKS_SHEET = "Tarefas";
const OPEN = "☐";
const DONE = "☑";

/** Finds one item by id or name (accents and case ignored); asks when unsure. */
export function resolveByName<T>(
  items: T[],
  query: string,
  nameOf: (item: T) => string,
  idOf: (item: T) => string,
  what: string,
): T {
  const raw = query.trim();
  const byId = items.find((item) => idOf(item) === raw);
  if (byId) return byId;
  // The start of an id is enough (names can repeat; the list below shows 8 characters).
  if (/^[0-9a-f-]{8,}$/i.test(raw)) {
    const byPrefix = items.filter((item) => idOf(item).startsWith(raw.toLowerCase()));
    if (byPrefix.length === 1) return byPrefix[0]!;
  }
  const wanted = fold(query);
  const exact = items.filter((item) => fold(nameOf(item)) === wanted);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : items.filter((item) => fold(nameOf(item)).includes(wanted));
  if (partial.length === 1) return partial[0]!;
  const names = (list: T[]) => {
    const shown = list.slice(0, 6);
    const repeated = (name: string) => shown.filter((other) => fold(nameOf(other)) === fold(name)).length > 1;
    return shown
      .map((item) => {
        const name = nameOf(item);
        const id = idOf(item);
        return repeated(name) && id ? `"${name}" (id ${id.slice(0, 8)})` : `"${name}"`;
      })
      .join(", ");
  };
  if (partial.length > 1)
    throw new ResolutionError(`Há mais de um ${what} parecido com "${query}": ${names(partial)}. Qual deles?`);
  throw new ResolutionError(
    items.length
      ? `Nenhum ${what} chamado "${query}". Existem: ${names(items)}${items.length > 6 ? "…" : ""}.`
      : `Ainda não há nenhum ${what}.`,
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function createOperations(client: AniClient) {
  const decks = async () => (await client.get<{ decks: Deck[] }>("/api/decks")).decks;
  const notebooks = async () => (await client.get<{ notebooks: NotebookSummary[] }>("/api/notebooks")).notebooks;
  const notebookSheets = async (id: string) =>
    (await client.get<{ notebook: { id: string; name: string }; sheets: Sheet[] }>(`/api/notebooks/${id}`)).sheets;
  const readSheetHtml = async (id: string) =>
    (await client.get<{ sheet: Sheet & { html: string } }>(`/api/sheets/${id}`)).sheet;

  async function findNotebook(query: string) {
    return resolveByName(
      await notebooks(),
      query,
      (n) => n.name,
      (n) => n.id,
      "caderno",
    );
  }

  // ---- Account and the day ----

  async function account(): Promise<string> {
    const me = await client.get<{ email: string }>("/api/account");
    return `Conectado ao ANI-9 como ${me.email}.`;
  }

  async function today(): Promise<string> {
    const [stats, forecast, deckList] = await Promise.all([
      client.get<{ currentStreak?: number; heatmap: { date: string; count: number }[] }>("/api/stats"),
      client.get<{ scheduled: number[]; overdue: number }>("/api/stats/forecast?days=7"),
      decks(),
    ]);
    const studied = stats.heatmap.at(-1)?.count ?? 0;
    const due = forecast.scheduled[0] ?? 0;
    const active = deckList.filter((d) => d.parentId === null && !d.archived);
    const newCards = active.reduce((sum, d) => sum + d.newCount, 0);
    const top = [...active]
      .filter((d) => d.dueCount > 0)
      .sort((a, b) => b.dueCount - a.dueCount)
      .slice(0, 3)
      .map((d) => `${d.name} (${d.dueCount})`);
    return [
      due === 0
        ? "Nada para revisar hoje."
        : `${plural(due, "revisão", "revisões")} para hoje${forecast.overdue ? `, ${forecast.overdue} delas atrasadas` : ""}.`,
      `${plural(studied, "revisão feita", "revisões feitas")} hoje.`,
      stats.currentStreak !== undefined ? `Sequência: ${plural(stats.currentStreak, "dia", "dias")}.` : "",
      newCards ? `${plural(newCards, "cartão novo", "cartões novos")} disponíveis.` : "",
      top.length ? `Mais revisões em: ${top.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  async function statistics(): Promise<string> {
    const stats = await client.get<{
      counts: Record<string, number>;
      retentionRate: number | null;
      forecast: { label: string; count: number }[];
      currentStreak?: number;
    }>("/api/stats");
    const c = stats.counts;
    return [
      `${plural(c.total ?? 0, "cartão", "cartões")}: ${c.new ?? 0} novos, ${(c.learning ?? 0) + (c.relearning ?? 0)} aprendendo, ${c.review ?? 0} em revisão, ${c.suspended ?? 0} suspensos.`,
      stats.retentionRate !== null && stats.retentionRate !== undefined
        ? `Retenção: ${Math.round(stats.retentionRate * 100)}%.`
        : "",
      stats.currentStreak !== undefined ? `Sequência: ${plural(stats.currentStreak, "dia", "dias")}.` : "",
      stats.forecast.length
        ? `Próximas semanas: ${stats.forecast.map((f) => `${f.label} ${f.count}`).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  // ---- Decks and cards ----

  async function listDecks(includeArchived = false): Promise<string> {
    const list = (await decks()).filter((d) => includeArchived || !d.archived);
    if (!list.length) return "Nenhum baralho ainda.";
    return list
      .map(
        (d) =>
          `- ${d.namePath}: ${d.dueCount} para revisar, ${d.newCount} novos, ${d.totalCount} no total${d.archived ? " (arquivado)" : ""}`,
      )
      .join("\n");
  }

  async function searchCards(query: string, limit = 10): Promise<string> {
    const params = new URLSearchParams({ query, limit: String(Math.min(Math.max(limit, 1), 20)), offset: "0" });
    const page = await client.get<{ cards: { front: string; back: string; deckName: string }[]; total: number }>(
      `/api/cards?${params}`,
    );
    if (!page.cards.length) return `Nenhum cartão encontrado para "${query}".`;
    const lines = page.cards.map((card) => {
      const back = card.back.includes('<hr id="answer">')
        ? card.back.split('<hr id="answer">').slice(1).join("")
        : card.back;
      return `- ${clip(htmlToText(card.front), 160)} → ${clip(htmlToText(back), 160)} [${card.deckName}]`;
    });
    return `${plural(page.total, "cartão encontrado", "cartões encontrados")}${page.total > page.cards.length ? `, mostrando ${page.cards.length}` : ""}:\n${lines.join("\n")}`;
  }

  async function createNote(input: { deck: string; front: string; back: string }): Promise<string> {
    const deck = resolveByName(
      (await decks()).filter((d) => !d.archived),
      input.deck,
      (d) => d.namePath,
      (d) => d.id,
      "baralho",
    );
    const front = input.front.trim();
    const back = input.back.trim();
    if (!front || !back) throw new ResolutionError("Preciso da frente e do verso do cartão.");
    await client.post(`/api/decks/${deck.id}/notes`, { fields: [escapeHtml(front), escapeHtml(back)] });
    return `Cartão criado em ${deck.namePath}: "${clip(front, 80)}".`;
  }

  // ---- Notebooks ----

  async function listNotebooks(): Promise<string> {
    const list = await notebooks();
    if (!list.length) return "Nenhum caderno ainda.";
    return list
      .map(
        (n) =>
          `- ${n.name} (${plural(n.sheetCount, "folha", "folhas")})${n.tags.length ? ` · ${n.tags.join(", ")}` : ""}`,
      )
      .join("\n");
  }

  async function readNotebook(query: string): Promise<string> {
    const notebook = await findNotebook(query);
    const sheets = await notebookSheets(notebook.id);
    if (!sheets.length) return `O caderno ${notebook.name} não tem folhas.`;
    return `Caderno ${notebook.name}:\n${sheets.map((s, i) => `${i + 1}. ${s.title || "Sem título"} (id ${s.id})`).join("\n")}`;
  }

  async function readSheet(sheetId: string): Promise<string> {
    const sheet = await readSheetHtml(sheetId);
    const text = htmlToText(sheet.html);
    return `${sheet.title || "Sem título"}\n\n${text ? clip(text, 6000) : "(folha vazia)"}`;
  }

  async function createNotebook(name: string): Promise<string> {
    const clean = name.trim();
    if (!clean) throw new ResolutionError("Qual nome dou ao caderno?");
    await client.post("/api/notebooks", { name: clean });
    return `Caderno "${clean}" criado.`;
  }

  async function createSheet(input: { notebook: string; title: string; text?: string }): Promise<string> {
    const notebook = await findNotebook(input.notebook);
    // The API answers with the sheet itself (not wrapped).
    const created = await client.post<Sheet>(`/api/notebooks/${notebook.id}/sheets`, {
      title: input.title.trim(),
      html: input.text ? textToHtml(input.text) : "",
    });
    return `Folha "${input.title.trim()}" criada no caderno ${notebook.name} (id ${created.id}).`;
  }

  async function appendToSheet(input: { sheetId: string; text: string }): Promise<string> {
    if (!input.text.trim()) throw new ResolutionError("O que devo anotar?");
    const sheet = await readSheetHtml(input.sheetId);
    await client.patch(`/api/sheets/${sheet.id}`, { html: `${sheet.html}${textToHtml(input.text)}` });
    return `Anotado na folha "${sheet.title || "Sem título"}".`;
  }

  // ---- Roadmaps ----

  async function listRoadmaps(): Promise<string> {
    const list = (await client.get<{ roadmaps: RoadmapListItem[] }>("/api/roadmaps")).roadmaps;
    if (!list.length) return "Nenhum roadmap ainda.";
    return list
      .map((r) => `- ${r.roadmap.title}: ${r.done} de ${r.total} feitos${r.role === "dono" ? "" : ` (${r.role})`}`)
      .join("\n");
  }

  async function readRoadmap(query: string): Promise<string> {
    const list = (await client.get<{ roadmaps: RoadmapListItem[] }>("/api/roadmaps")).roadmaps;
    const item = resolveByName(
      list,
      query,
      (r) => r.roadmap.title,
      (r) => r.roadmap.id,
      "roadmap",
    );
    const view = await client.get<{ nodes: RoadmapNode[]; edges: { fromId: string; toId: string }[] }>(
      `/api/roadmaps/${item.roadmap.id}`,
    );
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const order = (a: RoadmapNode, b: RoadmapNode) => a.y - b.y || a.x - b.x;
    const mark = (n: RoadmapNode) => (n.progress === "feito" ? " ✓" : n.progress === "estudando" ? " (estudando)" : "");
    const used = new Set<string>();
    const lines: string[] = [];
    for (const topic of view.nodes.filter((n) => n.kind === "topic").sort(order)) {
      used.add(topic.id);
      lines.push(
        `${lines.length ? "\n" : ""}• ${topic.title}${mark(topic)} [id ${topic.id}]${topic.summary ? ` — ${clip(topic.summary, 200)}` : ""}`,
      );
      const subs = view.edges
        .filter((e) => e.fromId === topic.id)
        .map((e) => byId.get(e.toId))
        .filter((n): n is RoadmapNode => n?.kind === "subtopic")
        .sort(order);
      for (const sub of subs) {
        used.add(sub.id);
        lines.push(`  - ${sub.title}${mark(sub)} [id ${sub.id}]`);
      }
    }
    const loose = view.nodes.filter((n) => !used.has(n.id));
    if (loose.length) lines.push(`\nOutros cartões: ${loose.map((n) => `${n.title}${mark(n)}`).join(", ")}`);
    return `${item.roadmap.title} — ${item.done} de ${item.total} feitos.\n${lines.join("\n")}`;
  }

  async function setRoadmapProgress(input: {
    nodeId: string;
    status: "estudando" | "feito" | "nenhum";
  }): Promise<string> {
    await client.put(`/api/roadmap-nodes/${input.nodeId}/progress`, {
      status: input.status === "nenhum" ? null : input.status,
    });
    return input.status === "nenhum" ? "Progresso apagado." : `Marcado como ${input.status}.`;
  }

  // ---- Tasks (a sheet "Tarefas" in a notebook "Tarefas", one line per task) ----

  async function tasksSheet(create: boolean): Promise<(Sheet & { html: string }) | null> {
    let notebook = (await notebooks()).find((n) => fold(n.name) === fold(TASKS_NOTEBOOK));
    if (!notebook) {
      if (!create) return null;
      await client.post("/api/notebooks", { name: TASKS_NOTEBOOK });
      notebook = (await notebooks()).find((n) => fold(n.name) === fold(TASKS_NOTEBOOK));
      if (!notebook) throw new Error("O caderno de tarefas não apareceu depois de criado.");
    }
    const sheets = await notebookSheets(notebook.id);
    let sheet = sheets.find((s) => fold(s.title) === fold(TASKS_SHEET));
    if (!sheet) {
      if (!create) return null;
      sheet = await client.post<Sheet>(`/api/notebooks/${notebook.id}/sheets`, { title: TASKS_SHEET, html: "" });
    }
    return readSheetHtml(sheet.id);
  }

  const taskLines = (html: string) =>
    htmlToText(html)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(OPEN) || line.startsWith(DONE));

  async function listTasks(includeDone = false): Promise<string> {
    const sheet = await tasksSheet(false);
    const lines = sheet ? taskLines(sheet.html) : [];
    const open = lines.filter((l) => l.startsWith(OPEN));
    const shown = includeDone ? lines : open;
    if (!shown.length)
      return open.length === 0 && lines.length ? "Todas as tarefas estão concluídas." : "Nenhuma tarefa.";
    return `${plural(open.length, "tarefa aberta", "tarefas abertas")}:\n${shown.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
  }

  async function addTask(text: string): Promise<string> {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) throw new ResolutionError("Qual é a tarefa?");
    const sheet = (await tasksSheet(true))!;
    await client.patch(`/api/sheets/${sheet.id}`, { html: `${sheet.html}<p>${OPEN} ${escapeHtml(clean)}</p>` });
    return `Tarefa anotada: ${clean}.`;
  }

  async function completeTask(query: string): Promise<string> {
    const sheet = await tasksSheet(false);
    const open = sheet ? taskLines(sheet.html).filter((l) => l.startsWith(OPEN)) : [];
    if (!sheet || !open.length) throw new ResolutionError("Não há tarefas abertas.");
    const asNumber = Number(query.trim());
    const target =
      Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= open.length
        ? open[asNumber - 1]!
        : resolveByName(
            open,
            query,
            (l) => l.slice(OPEN.length).trim(),
            () => "",
            "tarefa",
          );
    const label = target.slice(OPEN.length).trim();
    // Compare by text, not markup: the ANI-9 cleans sheet HTML on save and may re-encode it.
    let replaced = false;
    const html = sheet.html.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (block) => {
      if (replaced || htmlToText(block) !== `${OPEN} ${label}`) return block;
      replaced = true;
      return `<p>${DONE} ${escapeHtml(label)}</p>`;
    });
    if (!replaced) throw new ResolutionError(`Não consegui marcar "${label}". A folha de tarefas foi editada à mão?`);
    await client.patch(`/api/sheets/${sheet.id}`, { html });
    return `Concluída: ${label}.`;
  }

  return {
    account,
    today,
    statistics,
    listDecks,
    searchCards,
    createNote,
    listNotebooks,
    readNotebook,
    readSheet,
    createNotebook,
    createSheet,
    appendToSheet,
    listRoadmaps,
    readRoadmap,
    setRoadmapProgress,
    listTasks,
    addTask,
    completeTask,
  };
}

export type Operations = ReturnType<typeof createOperations>;
