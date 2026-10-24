// Bundles the app with esbuild: main and preload (CommonJS for Electron), the
// panel (browser), and the two MCP servers as single files, so the app needs
// no node_modules at run time. Electron runs them as Node (ELECTRON_RUN_AS_NODE).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: true, logLevel: "warning", target: "node22" };
mkdirSync("dist/renderer", { recursive: true });
await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/app.ts"],
    outfile: "dist/renderer/app.js",
    platform: "browser",
    format: "iife",
    target: "chrome140",
  }),
  build({
    ...common,
    entryPoints: ["../ani-mcp/src/index.ts"],
    outfile: "dist/mcp/ani.mjs",
    platform: "node",
    format: "esm",
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  }),
  build({
    ...common,
    entryPoints: ["../app-mcp/src/main.ts"],
    outfile: "dist/mcp/app.mjs",
    platform: "node",
    format: "esm",
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  }),
]);
copyFileSync("src/renderer/index.html", "dist/renderer/index.html");
copyFileSync("src/renderer/styles.css", "dist/renderer/styles.css");
console.log("build pronto em dist/");
