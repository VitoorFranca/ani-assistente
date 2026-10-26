import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, createCatalog, runProcess, type Runner } from "../src/catalog.js";

// A real git catalog (a local "GitHub"), the real validator replaced by a stub,
// and gh played by the test.

let root: string;
let remote: string;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roadmaps-mcp-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "models"), { recursive: true });
  mkdirSync(join(seed, "scripts"), { recursive: true });
  mkdirSync(join(seed, ".claude/skills/criar-roadmap/references"), { recursive: true });
  mkdirSync(join(seed, "docs"), { recursive: true });
  writeFileSync(
    join(seed, ".claude/skills/criar-roadmap/SKILL.md"),
    "---\nname: criar-roadmap\n---\n# Criar roadmap\nTodo cartão tem fontes.\n",
  );
  writeFileSync(join(seed, ".claude/skills/criar-roadmap/references/fontes.md"), "# Fontes\n");
  writeFileSync(join(seed, "docs/formato.md"), "# Formato 2\n");
  // The stub validator: fails when the model has a topic without resources.
  writeFileSync(
    join(seed, "scripts/validate.mjs"),
    `import { readFileSync } from "node:fs";
const file = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bad = file.topics.filter((t) => !t.resources?.length);
console.log(file.topics.length + " tópicos, 1 cartões, 1 fontes.");
if (process.argv.includes("--titles")) console.log("TÍTULO tópico 1\\n       fonte:  x\\n       página: X");
for (const t of bad) console.log('ERRO   tópico "' + t.title + '": cartão sem fonte');
console.log(bad.length ? bad.length + " erro(s): corrija o modelo." : "Sem erros.");
process.exit(bad.length ? 1 : 0);
`,
  );
  writeFileSync(
    join(seed, "models/go.json"),
    JSON.stringify({ format: "ani9-roadmap", version: 2, title: "Go", topics: [{ title: "A", resources: [1] }] }),
  );
  writeFileSync(
    join(seed, "README.md"),
    "# Roadmaps\n\n| Roadmap | Tema | Nível | Arquivo |\n|---|---|---|---|\n| Go | Tecnologia | x | [`models/go.json`](models/go.json) |\n\nFim.\n",
  );
  sh(seed, "init", "-q", "-b", "main");
  sh(seed, "add", ".");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
  remote = join(root, "remote.git");
  sh(root, "clone", "-q", "--bare", seed, remote);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeGh(options: { push: boolean; loggedIn?: boolean }) {
  const calls: string[][] = [];
  const run: Runner = async (command, args, opts) => {
    if (command !== "gh") {
      // Commits in the test need an identity; the person's own git config is used in real life.
      const env = command === "git" ? ["-c", "user.name=Teste", "-c", "user.email=teste@exemplo.org"] : [];
      return runProcess(command, [...env, ...args], opts);
    }
    calls.push(args);
    if (args[0] === "auth") return { code: options.loggedIn === false ? 1 : 0, stdout: "", stderr: "" };
    if (args[0] === "api" && args[1] === "repos/dono/catalogo")
      return { code: 0, stdout: String(options.push), stderr: "" };
    if (args[0] === "pr" && args[1] === "view") return { code: 1, stdout: "", stderr: "no pull requests" };
    if (args[0] === "pr" && args[1] === "create")
      return { code: 0, stdout: "https://github.com/dono/catalogo/pull/7\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `gh ${args.join(" ")} não esperado` };
  };
  return { run, calls };
}

const roadmap = (resources: unknown[]) => ({
  format: "ani9-roadmap",
  version: 2,
  title: "Química geral",
  area: "natureza",
  level: "iniciante",
  topics: [{ title: "Átomos", resources }],
});

describe("catalog", () => {
  it("clones the catalog and returns its rules (skill without frontmatter, references, format) and roadmaps", async () => {
    const catalog = createCatalog({ dir: join(root, "clone"), repo: "dono/catalogo", cloneUrl: remote });
    const { rules, models } = await catalog.prepare();
    expect(rules).toContain("# Criar roadmap");
    expect(rules).not.toContain("name: criar-roadmap");
    expect(rules).toContain("# Formato 2");
    expect(rules).toContain("roadmap_salvar_e_validar");
    expect(models).toEqual([{ key: "go", title: "Go", version: 2, topics: 1, cards: 1, sources: 1 }]);
    // A second call updates instead of cloning again.
    await expect(catalog.prepare()).resolves.toBeTruthy();
    expect(catalog.read("go")).toContain('"Go"');
    expect(() => catalog.read("Não Slug")).toThrow(CatalogError);
  });

  it("saves a draft on roadmap/<key> and returns the validator's errors first", async () => {
    const catalog = createCatalog({ dir: join(root, "clone"), repo: "dono/catalogo", cloneUrl: remote });
    await catalog.prepare();
    const bad = await catalog.saveAndValidate("quimica-geral", roadmap([]));
    expect(bad.ok).toBe(false);
    expect(bad.report.split("\n")[0]).toMatch(/tópicos,|ERRO/);
    expect(bad.report).toContain('ERRO   tópico "Átomos"');
    expect(sh(join(root, "clone"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("roadmap/quimica-geral");

    const good = await catalog.saveAndValidate("quimica-geral", JSON.stringify(roadmap([{ kind: "teoria" }])));
    expect(good.ok).toBe(true);
    expect(good.report).toContain("Sem erros.");
    expect(good.report).toContain("TÍTULO");
    await expect(catalog.saveAndValidate("quimica-geral", "{ não é json")).rejects.toThrow(/JSON válido/);
  });

  it("opens the pull request with gh when the person can push: commit, README row, branch on GitHub", async () => {
    const gh = fakeGh({ push: true });
    const catalog = createCatalog({ dir: join(root, "clone"), repo: "dono/catalogo", cloneUrl: remote, run: gh.run });
    await catalog.prepare();
    await catalog.saveAndValidate("quimica-geral", roadmap([{ kind: "teoria" }]), false);
    const { url, viaFork } = await catalog.openPullRequest("quimica-geral", {});
    expect(url).toBe("https://github.com/dono/catalogo/pull/7");
    expect(viaFork).toBe(false);
    // The branch reached the "GitHub" remote with the roadmap and the README row.
    const readme = sh(remote, "show", "roadmap/quimica-geral:README.md");
    expect(readme).toContain("| Química geral | Ciências da natureza | Iniciante | [`models/quimica-geral.json`]");
    expect(readme.indexOf("Química geral")).toBeLessThan(readme.indexOf("Fim."));
    expect(sh(remote, "log", "-1", "--format=%s", "roadmap/quimica-geral")).toBe("Roadmap: Química geral");
    const create = gh.calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--repo", "dono/catalogo", "--head", "roadmap/quimica-geral"]));
  });

  it("refuses to publish without gh signed in, or with a roadmap that does not validate", async () => {
    const catalog = createCatalog({
      dir: join(root, "clone"),
      repo: "dono/catalogo",
      cloneUrl: remote,
      run: fakeGh({ push: true, loggedIn: false }).run,
    });
    await catalog.prepare();
    await catalog.saveAndValidate("quimica-geral", roadmap([]), false);
    await expect(catalog.openPullRequest("quimica-geral", {})).rejects.toThrow(/gh auth login/);
    const signedIn = createCatalog({
      dir: join(root, "clone"),
      repo: "dono/catalogo",
      cloneUrl: remote,
      run: fakeGh({ push: true }).run,
    });
    await expect(signedIn.openPullRequest("quimica-geral", {})).rejects.toThrow(/validador ainda aponta erros/);
    expect(readFileSync(join(root, "clone", "models", "quimica-geral.json"), "utf8")).toContain("Átomos");
  });
});
