# AGENTS.md

VS Code extension that drives `opencode-tellico serve` (from
tellico-agentic-setup) over OpenCode 2's HTTP API and renders a chat UI.

## Commands

- `npm run build` / `npm run watch` -- esbuild bundles `dist/extension.js`
  (Node, CJS) and `dist/webview.js` + `.css` (browser).
- `npm test` -- vitest; offline, driven by `test/fixtures/*.events.json`.
- `npm run typecheck` -- host and webview tsconfigs.
- `TELLICO_LIVE=1 npx vitest run test/live.test.ts` -- real server, real
  cluster slot. Run it after touching `src/server/`.
- `npm run package` -- `.vsix`.

## Boundaries

- **No Tellico logic here.** Node choice, agents, prompts, plugins, Magic
  Context, tunnel/gateway all belong to the launcher. The extension passes
  the same flags and env a terminal user would (`src/server/manager.ts`) and
  never builds `OPENCODE_CONFIG_CONTENT` itself. If the extension needs
  something new from the server, add it to `opencode-tellico serve`.
- **`src/server/api.ts` is the only module that knows routes.** OpenCode 2
  only (`/api/*`, verified against 2.0.26's `/openapi.json`). A v1 adapter
  would be a sibling with the same method signatures.
- **Never forward provider/model/config payloads** to the webview or logs:
  `GET /api/model`, `/api/model/default` and `/api/provider` return the API
  key in `settings.apiKey`. `Api` methods return only the fields the UI uses.
- **The event stream has no replay and no auto-reconnect.** `EventStream`
  reconnects; the controller then reloads every open session from history.
  Keep `Store.apply` (live) and `Store.loadHistory` (history) producing the
  same shape -- a test compares them.
- **Host owns state; the webview renders.** Session updates go out as
  `{from, tail}` so streaming only re-sends the tail; the webview applies
  updates once per animation frame. Keep both, they are what makes streaming
  smooth on long sessions.
- **Agent names are a contract** with tellico-agentic-setup:
  `build-tellico-N`, `orchestrate-tellico-N`, `tellico-worker-N`. The model
  id is read from the agent list, never hardcoded.
- Webview: React + marked + DOMPurify, styled only with `--vscode-*`
  variables. Effects must not return values (React calls them as cleanup).

## Fixtures

Recorded from a real server; see `test/fixtures/README.md` for how to
re-record after an OpenCode upgrade. Scrub paths and hostnames before
committing them.
