import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The public roadmap catalog (github.com/VitoorFranca/ani9-roadmaps) in a
// local clone: its own rules (the criar-roadmap skill and the format), its
// validator, and pull requests through the person's own gh login. The app
// never sees a GitHub credential: git asks gh for one per push.

export const DEFAULT_REPO = "VitoorFranca/ani9-roadmaps";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell; tests replace it. */
export type Runner = (command: string, args: string[], options?: { cwd?: string }) => Promise<RunResult>;

export const runProcess: Runner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: stderr + error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export class CatalogError extends Error {}

export interface CatalogOptions {
  /** Where the local clone lives (created on first use). */
  dir: string;
  /** owner/name on GitHub. */
  repo?: string;
  /** Where to clone from (default: the repo on GitHub; tests use a local one). */
  cloneUrl?: string;
  run?: Runner;
  /** The program that runs the validator (node, or Electron as node). */
  node?: string;
}

const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const AREA = {
  exatas: "Exatas e matemática",
  natureza: "Ciências da natureza",
  saude: "Saúde",
  humanidades: "Humanidades",
  linguas: "Línguas e comunicação",
  direito: "Direito",
  negocios: "Negócios e finanças",
  tecnologia: "Tecnologia",
  engenharia: "Engenharia",
  artes: "Artes e design",
  educacao: "Educação",
  concursos: "Concursos e vestibulares",
  outros: "Outros",
} as Record<string, string>;
const LEVEL = {
  iniciante: "Iniciante",
  intermediario: "Intermediário",
  avancado: "Avançado",
  completo: "Do básico ao avançado",
} as Record<string, string>;

interface Node {
  title?: string;
  resources?: unknown[];
  subtopics?: Node[];
}

const countCards = (nodes: Node[] = []): { cards: number; sources: number } =>
  nodes.reduce(
    (total, node) => {
      const inner = countCards(node.subtopics);
      return {
        cards: total.cards + 1 + inner.cards,
        sources: total.sources + (node.resources?.length ?? 0) + inner.sources,
      };
    },
    { cards: 0, sources: 0 },
  );

export function createCatalog(options: CatalogOptions) {
  const repo = options.repo ?? DEFAULT_REPO;
  const run = options.run ?? runProcess;
  const node = options.node ?? process.execPath;
  const dir = options.dir;
  const modelPath = (key: string) => join(dir, "models", `${key}.json`);

  async function must(command: string, args: string[], what: string): Promise<string> {
    const result = await run(command, args, { cwd: existsSync(dir) ? dir : dirname(dir) });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
      throw new CatalogError(`${what}: ${detail || `código ${result.code}`}`);
    }
    return result.stdout.trim();
  }
  const git = (args: string[], what: string) => must("git", args, what);
  /** git with gh as the credential helper for this command only (no global configuration is changed). */
  const gitWithGh = (args: string[], what: string) =>
    git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args], what);

  function checkKey(key: string) {
    if (!KEY.test(key))
      throw new CatalogError(`A chave "${key}" deve ser um slug: a-z, 0-9 e hífen, como "back-end-node".`);
  }

  function readText(path: string) {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** The skill without its frontmatter, plus its references and the format: the catalog's current rules. */
  function rules(): string {
    const skillDir = join(dir, ".claude", "skills", "criar-roadmap");
    const skill = readText(join(skillDir, "SKILL.md")).replace(/^---[\s\S]*?---\s*/, "");
    const parts = [
      "# Como usar estas regras no assistente\n\n" +
        "- Os passos que gravam o arquivo e rodam o validador viram a ferramenta roadmap_salvar_e_validar; " +
        'repita até "Sem erros." e confira a saída TÍTULO.\n' +
        "- Os passos de git e gh viram a ferramenta roadmap_abrir_pr, que só roda com a confirmação da pessoa.\n" +
        "- Pesquise e abra as fontes com WebSearch e WebFetch. Nunca invente URLs.\n" +
        "- Antes de começar, confirme com a pessoa o plano (tema, público, nível) com confirmar_plano.",
      skill,
      readText(join(skillDir, "references", "fontes.md")),
      readText(join(skillDir, "references", "qualidade.md")),
      readText(join(dir, "docs", "formato.md")),
    ];
    return parts.filter(Boolean).join("\n\n---\n\n");
  }

  function list() {
    const models = existsSync(join(dir, "models"))
      ? readdirSync(join(dir, "models")).filter((name) => name.endsWith(".json"))
      : [];
    return models.sort().map((name) => {
      const key = name.slice(0, -".json".length);
      try {
        const file = JSON.parse(readFileSync(modelPath(key), "utf8"));
        const { cards, sources } = countCards(file.topics);
        return {
          key,
          title: String(file.title ?? key),
          version: Number(file.version),
          topics: file.topics?.length ?? 0,
          cards,
          sources,
        };
      } catch {
        return { key, title: key, version: 0, topics: 0, cards: 0, sources: 0 };
      }
    });
  }

  return {
    repo,
    dir,

    /** Clones the catalog or brings it up to date on main; returns the rules and the existing roadmaps. */
    async prepare() {
      if (!existsSync(join(dir, ".git"))) {
        mkdirSync(dirname(dir), { recursive: true });
        await git(
          ["clone", options.cloneUrl ?? `https://github.com/${repo}.git`, dir],
          "Não consegui baixar o catálogo",
        );
      } else {
        await git(["checkout", "main"], "Não consegui voltar ao main do catálogo (há mudanças locais?)");
        await git(["pull", "--ff-only", "origin", "main"], "Não consegui atualizar o catálogo");
      }
      return { rules: rules(), models: list() };
    },

    list,

    read(key: string): string {
      checkKey(key);
      if (!existsSync(modelPath(key))) throw new CatalogError(`Não há roadmap "${key}" no catálogo.`);
      return readFileSync(modelPath(key), "utf8");
    },

    /**
     * Writes models/<key>.json (on the branch roadmap/<key>, from main) and runs
     * the catalog's validator; with titles, also each page's real title.
     */
    async saveAndValidate(key: string, roadmap: unknown, titles = true): Promise<{ ok: boolean; report: string }> {
      checkKey(key);
      if (!existsSync(join(dir, ".git"))) throw new CatalogError("Prepare o catálogo antes (roadmap_preparar).");
      let parsed = roadmap;
      if (typeof roadmap === "string") {
        try {
          parsed = JSON.parse(roadmap);
        } catch (error) {
          throw new CatalogError(`O roadmap não é um JSON válido: ${error instanceof Error ? error.message : error}`);
        }
      }
      const branch = `roadmap/${key}`;
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], "Não consegui ler o branch atual");
      if (current !== branch) {
        const exists = (await run("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: dir })).code === 0;
        await git(
          exists ? ["checkout", branch] : ["checkout", "-b", branch, "main"],
          `Não consegui abrir o branch ${branch}`,
        );
      }
      writeFileSync(modelPath(key), `${JSON.stringify(parsed, null, 2)}\n`);
      const args = [join(dir, "scripts", "validate.mjs"), modelPath(key), titles ? "--titles" : "--check-links"];
      const result = await run(node, args, { cwd: dir });
      const output = (result.stdout + result.stderr).trim();
      // Errors and warnings first: they are what needs fixing; the titles after.
      const lines = output.split("\n");
      const important = lines.filter((line) => /^(ERRO|AVISO)|tópicos,|Sem erros|erro\(s\)/.test(line));
      const rest = lines.filter((line) => !important.includes(line));
      const report = [...important, "", ...rest].join("\n");
      return {
        ok: result.code === 0,
        report: report.length > 60_000 ? `${report.slice(0, 60_000)}\n… (cortado)` : report,
      };
    },

    /**
     * Commits models/<key>.json (and a README row for a new roadmap) on
     * roadmap/<key> and opens the pull request with gh: straight to the catalog
     * when the person can push there, otherwise through their fork.
     */
    async openPullRequest(
      key: string,
      input: { title?: string; body?: string },
    ): Promise<{ url: string; viaFork: boolean }> {
      checkKey(key);
      const branch = `roadmap/${key}`;
      const auth = await run("gh", ["auth", "status"], { cwd: dir });
      if (auth.code === 127) throw new CatalogError("O gh (GitHub CLI) não está instalado: https://cli.github.com");
      if (auth.code !== 0)
        throw new CatalogError("O gh não está conectado: rode `gh auth login` no Terminal e tente de novo.");

      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], "Não consegui ler o branch atual");
      if (current !== branch)
        throw new CatalogError(`Salve e valide o roadmap antes (roadmap_salvar_e_validar), no branch ${branch}.`);
      const check = await run(node, [join(dir, "scripts", "validate.mjs"), modelPath(key), "--check-links"], {
        cwd: dir,
      });
      if (check.code !== 0)
        throw new CatalogError(
          `O validador ainda aponta erros; corrija antes do pull request:\n${check.stdout.slice(-4000)}`,
        );

      const file = JSON.parse(readFileSync(modelPath(key), "utf8"));
      const isNew = (await run("git", ["cat-file", "-e", `main:models/${key}.json`], { cwd: dir })).code !== 0;
      const files = [`models/${key}.json`];
      if (isNew) {
        const readmePath = join(dir, "README.md");
        const readme = readText(readmePath);
        const row = `| ${file.title} | ${AREA[file.area] ?? "Outros"} | ${LEVEL[file.level] ?? ""} | [\`models/${key}.json\`](models/${key}.json) |`;
        const table = readme.match(/\| Roadmap \| Tema \| Nível \| Arquivo \|\n\|[-| ]+\|\n((?:\|.*\|\n)*)/);
        if (table && !readme.includes(`models/${key}.json`)) {
          const end = table.index! + table[0].length;
          writeFileSync(readmePath, `${readme.slice(0, end)}${row}\n${readme.slice(end)}`);
          files.push("README.md");
        }
      }
      await git(["add", ...files], "Não consegui preparar o commit");
      const staged = (await run("git", ["diff", "--cached", "--quiet"], { cwd: dir })).code !== 0;
      const { cards, sources } = countCards(file.topics);
      const title = input.title?.trim() || `Roadmap: ${file.title}`;
      if (staged) await git(["commit", "-m", title], "Não consegui fazer o commit");

      const canPush =
        (await run("gh", ["api", `repos/${repo}`, "-q", ".permissions.push"], { cwd: dir })).stdout.trim() === "true";
      let head = branch;
      if (canPush) {
        await gitWithGh(["push", "-u", "origin", branch], "Não consegui enviar o branch");
      } else {
        const login = (await must("gh", ["api", "user", "-q", ".login"], "Não consegui ler o login do GitHub")).trim();
        await must("gh", ["repo", "fork", repo, "--clone=false", "--remote=false"], "Não consegui criar o fork");
        const forkUrl = `https://github.com/${login}/${repo.split("/")[1]}.git`;
        await gitWithGh(["push", forkUrl, `${branch}:${branch}`], "Não consegui enviar o branch para o fork");
        head = `${login}:${branch}`;
      }
      const body =
        input.body?.trim() ||
        [
          "## O que muda",
          "",
          `${isNew ? "Roadmap novo" : "Revisão do roadmap"}: **${file.title}** (\`models/${key}.json\`), formato ${file.version}.`,
          `${file.topics?.length ?? 0} tópicos, ${cards} cartões, ${sources} fontes.`,
          "",
          "## Conferido",
          "",
          "- [x] `node scripts/validate.mjs` com `--titles` terminou sem erros.",
          "- [x] Feito com o assistente Ani seguindo a skill criar-roadmap.",
        ].join("\n");
      const existing = await run(
        "gh",
        ["pr", "view", head, "--repo", repo, "--json", "url,state", "-q", 'select(.state=="OPEN") | .url'],
        { cwd: dir },
      );
      if (existing.code === 0 && existing.stdout.trim()) return { url: existing.stdout.trim(), viaFork: !canPush };
      const url = await must(
        "gh",
        ["pr", "create", "--repo", repo, "--base", "main", "--head", head, "--title", title, "--body", body],
        "Não consegui abrir o pull request",
      );
      return { url: url.split("\n").pop()!.trim(), viaFork: !canPush };
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
