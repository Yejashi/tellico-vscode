// Builds the browser preview of the chat webview (see harness.ts). With
// --shot, screenshots every scene in dark and light with headless Chromium
// into dist-preview/shots/.

import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const out = "dist-preview";
mkdirSync(out, { recursive: true });
if (!existsSync("dist/webview.js")) execFileSync("node", ["esbuild.mjs"], { stdio: "inherit" });
for (const f of ["webview.js", "webview.css", "codicon.css", "codicon.ttf"]) copyFileSync(`dist/${f}`, `${out}/${f}`);
copyFileSync("scripts/preview/theme.css", `${out}/theme.css`);

await esbuild.build({
  entryPoints: { harness: "scripts/preview/harness.ts" },
  outdir: out,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  logLevel: "warning",
});

writeFileSync(
  `${out}/index.html`,
  `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<link rel="stylesheet" href="codicon.css"><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="webview.css">
<title>Tellico preview</title></head>
<body><div id="root"></div><script src="harness.js"></script><script src="webview.js"></script></body></html>
`,
);

if (process.argv.includes("--shot")) {
  const browser = ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(existsSync);
  if (!browser) throw new Error("No Chromium found for --shot");
  const only = process.argv.find((a) => a.startsWith("--scene="))?.slice(8);
  const typed = process.argv.find((a) => a.startsWith("--type="))?.slice(7);
  const size = process.argv.find((a) => a.startsWith("--size="))?.slice(7) ?? "420,860";
  const themes = process.argv.includes("--light") ? ["light"] : process.argv.includes("--both") ? ["dark", "light"] : ["dark"];
  const scenes = only ? only.split(",") : ["welcome", "starting", "failed", "fix-and-run", "fix-and-run-mid", "worker-dispatch", "worker-running", "guard-and-interrupt", "history", "extras", "rewind", "queued", "tools", "stats"];
  mkdirSync(`${out}/shots`, { recursive: true });
  for (const theme of themes)
    for (const scene of scenes) {
      const file = resolve(`${out}/shots/${scene}${typed ? "-typed" : ""}-${theme}.png`);
      execFileSync(browser, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${resolve(out, ".chrome")}`, `--window-size=${size}`, "--virtual-time-budget=4000",
        `--screenshot=${file}`, `file://${resolve(out, "index.html")}?scene=${scene}&theme=${theme}&shot${typed ? `&type=${encodeURIComponent(typed)}` : ""}`,
      ], { stdio: "ignore" });
      console.log(file);
    }
}
