// Bundles the extension host (Node/CommonJS) and the webview (browser) and
// copies the codicon font, so the packaged .vsix carries no node_modules.
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/codicon.css");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicon.ttf");

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: "info" };

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: { extension: "src/extension.ts" },
    outdir: "dist",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: "webview/main.tsx" },
    outdir: "dist",
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    loader: { ".css": "css" },
    define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
    inject: [],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
