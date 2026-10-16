// Runs test/vscode/index.cjs inside a throwaway VS Code (its own user data
// and extensions directories, a scratch git folder) and reports the result.
// Opens a window for a few seconds; needs `code` on PATH.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "tellico-smoke-"));
const ws = join(tmp, "ws");
mkdirSync(ws);
execFileSync("git", ["init", "-q"], { cwd: ws });
if (!existsSync("dist/extension.js")) execFileSync("node", ["esbuild.mjs"], { stdio: "inherit" });
const out = join(tmp, "out.txt");
spawnSync(
  "code",
  ["--wait", "--new-window", `--user-data-dir=${join(tmp, "ud")}`, `--extensions-dir=${join(tmp, "ext")}`, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    `--extensionDevelopmentPath=${resolve(".")}`, `--extensionTestsPath=${resolve("test/vscode/index.cjs")}`, ws],
  { env: { ...process.env, TELLICO_SMOKE_OUT: out }, stdio: "ignore", timeout: 180_000 },
);
const result = existsSync(out) ? readFileSync(out, "utf8").trim() : "tellico smoke: no result (VS Code did not run the test)";
console.log(result);
process.exit(/: ok/.test(result) ? 0 : 1);
