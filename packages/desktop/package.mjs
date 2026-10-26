// Builds release/Ani-darwin-arm64/Ani.app (and a zip next to it).
// Signing:
//   default            ad-hoc signature (local use / community builds)
//   SIGN_IDENTITY=...  Developer ID + hardened runtime
//   + APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID  notarized and stapled
// Needs native/voz built (swift build -c release); without it the app runs without voice.
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const APP_NAME = "Ani";
const BUNDLE_ID = "io.github.vitoorfranca.ani-assistente"; // permanent: the microphone permission is tied to it
const voz = "../../native/voz/.build/release/voz";

execFileSync("node", ["build.mjs"], { stdio: "inherit" });
rmSync("build/bin", { recursive: true, force: true });
mkdirSync("build/bin", { recursive: true });
if (existsSync(voz)) cpSync(voz, "build/bin/voz");
else console.warn("native/voz não compilado: o app sai sem voz (cd native/voz && swift build -c release).");

const identity = process.env.SIGN_IDENTITY || null;
const notarize =
  identity && process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;

const [appDir] = await packager({
  dir: ".",
  out: "release",
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  name: APP_NAME,
  appBundleId: BUNDLE_ID,
  icon: "build/macos/icon.icns",
  appCategoryType: "public.app-category.education",
  // The MCP servers run as their own processes: kept outside the archive.
  asar: { unpack: "**/dist/mcp/**" },
  prune: true,
  // Everything the app runs is bundled by esbuild into dist/.
  ignore: [/^\/(src|build|release|node_modules)(\/|$)/, /\.(ts|map)$/, /^\/(tsconfig\.json|build\.mjs|package\.mjs)$/],
  extraResource: ["build/bin"],
  ...(identity
    ? {
        osxSign: {
          identity,
          optionsForFile: (file) => ({
            hardenedRuntime: true,
            entitlements: /\/Resources\/bin\//.test(file) ? undefined : "build/macos/entitlements.plist",
          }),
        },
        osxNotarize: notarize,
      }
    : {}),
  extendInfo: {
    LSUIElement: true, // menu bar app, no Dock icon
    LSMinimumSystemVersion: "26.0",
    NSMicrophoneUsageDescription:
      "A Ani ouve o que você diz quando você aperta o atalho. O áudio é processado neste Mac e não sai dele.",
  },
});

const app = join(appDir, `${APP_NAME}.app`);
if (!identity) {
  const helper = join(app, "Contents", "Resources", "bin", "voz");
  if (existsSync(helper)) execFileSync("codesign", ["--force", "--sign", "-", helper], { stdio: "inherit" });
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--entitlements", "build/macos/entitlements.plist", app],
    {
      stdio: "inherit",
    },
  );
}
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
const zip = join("release", `${APP_NAME}-darwin-arm64.zip`);
rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
console.log(`pronto (${identity ? `Developer ID${notarize ? ", notarizado" : ""}` : "ad-hoc"}): ${app}\n${zip}`);
