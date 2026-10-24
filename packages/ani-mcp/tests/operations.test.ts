import { describe, expect, it } from "vitest";
import { AniError, type AniClient } from "../src/client.js";
import { createOperations, ResolutionError, resolveByName } from "../src/operations.js";
import { htmlToText, textToHtml } from "../src/text.js";

/** An in-memory ANI-9 with just enough of the API for the operations. */
function fakeAni() {
  const decks = [
    {
      id: "d1",
      name: "Medicina",
      namePath: "Medicina",
      parentId: null,
      archived: false,
      totalCount: 10,
      newCount: 2,
      dueCount: 5,
    },
    {
      id: "d2",
      name: "Fisiologia",
      namePath: "Medicina::Fisiologia",
      parentId: "d1",
      archived: false,
      totalCount: 4,
      newCount: 0,
      dueCount: 1,
    },
    {
      id: "d3",
      name: "Farmacologia",
      namePath: "Medicina::Farmacologia",
      parentId: "d1",
      archived: false,
      totalCount: 3,
      newCount: 1,
      dueCount: 0,
    },
  ];
  const notebooks: { id: string; name: string; sheetCount: number; tags: string[] }[] = [];
  const sheets: { id: string; notebookId: string; title: string; html: string }[] = [];
  const notes: { deckId: string; fields: string[] }[] = [];
  let seq = 0;
  const client: AniClient = {
    async get<T>(path: string) {
      if (path === "/api/decks") return { decks } as T;
      if (path === "/api/notebooks") return { notebooks } as T;
      if (path === "/api/stats")
        return {
          currentStreak: 4,
          heatmap: [{ date: "2026-10-24", count: 12 }],
          counts: {},
          retentionRate: 0.9,
          forecast: [],
        } as T;
      if (path.startsWith("/api/stats/forecast")) return { scheduled: [7, 3], overdue: 2 } as T;
      let m = path.match(/^\/api\/notebooks\/(.+)$/);
      if (m)
        return {
          notebook: notebooks.find((n) => n.id === m![1]),
          sheets: sheets.filter((s) => s.notebookId === m![1]),
        } as T;
      m = path.match(/^\/api\/sheets\/(.+)$/);
      if (m) {
        const sheet = sheets.find((s) => s.id === m![1]);
        if (!sheet) throw new AniError("Folha não encontrada.", "not_found", false, 404);
        return { sheet } as T;
      }
      throw new Error(`GET não previsto: ${path}`);
    },
    async post<T>(path: string, body: any) {
      if (path === "/api/notebooks") {
        const id = `n${++seq}`;
        notebooks.push({ id, name: body.name, sheetCount: 0, tags: [] });
        return { id, name: body.name } as T;
      }
      let m = path.match(/^\/api\/notebooks\/(.+)\/sheets$/);
      if (m) {
        const sheet = { id: `s${++seq}`, notebookId: m[1]!, title: body.title, html: body.html ?? "" };
        sheets.push(sheet);
        return sheet as T; // like the ANI-9: the sheet itself, not wrapped
      }
      m = path.match(/^\/api\/decks\/(.+)\/notes$/);
      if (m) {
        notes.push({ deckId: m[1]!, fields: body.fields });
        return {} as T;
      }
      throw new Error(`POST não previsto: ${path}`);
    },
    async patch<T>(path: string, body: any) {
      const m = path.match(/^\/api\/sheets\/(.+)$/);
      if (m) {
        // Like the ANI-9, the stored HTML is re-encoded (here: quotes left raw).
        sheets.find((s) => s.id === m[1])!.html = String(body.html).replace(/&quot;/g, '"');
        return {} as T;
      }
      throw new Error(`PATCH não previsto: ${path}`);
    },
    async put<T>() {
      return {} as T;
    },
  };
  return { client, decks, notebooks, sheets, notes };
}

describe("text", () => {
  it("turns card and sheet HTML into readable lines", () => {
    expect(
      htmlToText(
        "<h2>Respiração</h2><p>A <b>mitocôndria</b> produz ATP&nbsp;&amp; calor.</p><ul><li>um</li><li>dois</li></ul>",
      ),
    ).toBe("Respiração\nA mitocôndria produz ATP & calor.\n- um\n- dois");
    expect(htmlToText("{{c1::Brasília::capital}} é a capital")).toBe("Brasília é a capital");
  });

  it("writes text as escaped paragraphs", () => {
    expect(textToHtml("linha <1>\ncontinua\n\nnovo parágrafo")).toBe(
      "<p>linha &lt;1&gt;<br>continua</p><p>novo parágrafo</p>",
    );
  });
});

describe("resolveByName", () => {
  const items = ["Medicina::Fisiologia", "Medicina::Farmacologia", "Química"];
  const pick = (q: string) =>
    resolveByName(
      items,
      q,
      (x) => x,
      (x) => x,
      "baralho",
    );

  it("finds by exact name ignoring accents, or by a unique part", () => {
    expect(pick("quimica")).toBe("Química");
    expect(pick("fisio")).toBe("Medicina::Fisiologia");
  });

  it("tells repeated names apart by the start of their id, which then selects them", () => {
    const books = [
      { id: "aaaa1111-0000", name: "Bolha" },
      { id: "bbbb2222-0000", name: "Bolha" },
    ];
    const find = (q: string) =>
      resolveByName(
        books,
        q,
        (b) => b.name,
        (b) => b.id,
        "caderno",
      );
    expect(() => find("bolha")).toThrow('"Bolha" (id aaaa1111), "Bolha" (id bbbb2222)');
    expect(find("bbbb2222").id).toBe("bbbb2222-0000");
  });

  it("asks instead of guessing when several match, and lists options when none does", () => {
    expect(() => pick("Medicina")).toThrow(/mais de um baralho/);
    expect(() => pick("Direito")).toThrow(/Nenhum baralho chamado "Direito"/);
  });
});

describe("operations", () => {
  it("summarizes the day in a few spoken sentences", async () => {
    const text = await createOperations(fakeAni().client).today();
    expect(text).toBe(
      "7 revisões para hoje, 2 delas atrasadas. 12 revisões feitas hoje. Sequência: 4 dias. 2 cartões novos disponíveis. Mais revisões em: Medicina (5).",
    );
  });

  it("creates a note in the deck named, escaping the text, and refuses an ambiguous deck", async () => {
    const ani = fakeAni();
    const ops = createOperations(ani.client);
    expect(await ops.createNote({ deck: "fisiologia", front: "O que é <ATP>?", back: "Energia" })).toMatch(
      /Medicina::Fisiologia/,
    );
    expect(ani.notes).toEqual([{ deckId: "d2", fields: ["O que é &lt;ATP&gt;?", "Energia"] }]);
    await expect(ops.createNote({ deck: "Medicina::F", front: "a", back: "b" })).rejects.toBeInstanceOf(
      ResolutionError,
    );
  });

  it("keeps tasks in a Tarefas sheet: add, list and complete by number or text", async () => {
    const ani = fakeAni();
    const ops = createOperations(ani.client);
    expect(await ops.listTasks()).toBe("Nenhuma tarefa.");
    await ops.addTask('revisar "Fisiologia" até sexta');
    await ops.addTask("ler o capítulo 3");
    expect(ani.notebooks.map((n) => n.name)).toEqual(["Tarefas"]);
    expect(await ops.listTasks()).toBe(
      '2 tarefas abertas:\n1. ☐ revisar "Fisiologia" até sexta\n2. ☐ ler o capítulo 3',
    );
    expect(await ops.completeTask("fisiologia")).toBe('Concluída: revisar "Fisiologia" até sexta.');
    expect(await ops.completeTask("1")).toBe("Concluída: ler o capítulo 3.");
    expect(await ops.listTasks()).toBe("Todas as tarefas estão concluídas.");
    expect(await ops.listTasks(true)).toMatch(/☑ revisar "Fisiologia" até sexta/);
  });

  it("appends to a sheet without losing what was there", async () => {
    const ani = fakeAni();
    const ops = createOperations(ani.client);
    await ops.createNotebook("Biologia");
    await ops.createSheet({ notebook: "biologia", title: "Células", text: "Primeira linha." });
    const sheetId = ani.sheets[0]!.id;
    await ops.appendToSheet({ sheetId, text: "Nova anotação." });
    expect(await ops.readSheet(sheetId)).toBe("Células\n\nPrimeira linha.\nNova anotação.");
  });
});
