// Runs the chat webview in a plain browser, fed by the recorded fixtures
// through the real Store, so UI changes can be seen without VS Code or a
// cluster. `npm run preview` builds it; open dist-preview/index.html, or use
// `npm run preview -- --shot` for headless screenshots of every scene.
//
// Scenes are picked with ?scene=<name>&theme=dark|light.

import { Store, ServerEvent } from "../../src/state/reducer";
import type { HostToWebview, Prefs, SessionSummary } from "../../shared/protocol";
import fixAndRun from "../../test/fixtures/fix-and-run.events.json";
import workerDispatch from "../../test/fixtures/worker-dispatch.events.json";
import guardAndInterrupt from "../../test/fixtures/guard-and-interrupt.events.json";

const params = new URLSearchParams(location.search);
// Headless Chromium under a virtual time budget never fires animation frames.
if (params.has("shot")) {
  let t = 0;
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb((t += 16)), 16) as unknown as number;
  (window as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}
const sceneName = params.get("scene") ?? "fix-and-run";
const themeClass = params.get("theme") === "light" ? "vscode-light" : "vscode-dark";
// VS Code puts its variables on <html> and the theme class on <body>.
document.documentElement.classList.add(themeClass);
document.body.classList.add(themeClass);

const prefs: Prefs = {
  mode: "orchestrate",
  node: 1,
  think: "medium",
  attachActiveEditor: true,
  showReasoning: false,
  smoothStreaming: false,
  root: "/work/proj",
  connection: "tunnel",
  connectionSetting: "installed",
  magicContext: true,
};

const commands = [
  { name: "ctx-status", description: "Show Magic Context status" },
  { name: "ctx-flush", description: "Flush pending context operations" },
  { name: "review", description: "Review uncommitted changes" },
];

const now = Date.now();
const sessions: SessionSummary[] = [
  { id: "s1", title: "Fixing add() bug in calc.py", created: now - 3_600_000, updated: now - 120_000, agent: "build-tellico-1" },
  { id: "s2", title: "Count lines in calc.py with a worker", created: now - 86_400_000, updated: now - 80_000_000, agent: "orchestrate-tellico-0" },
  { id: "s3", title: "Refactor the event stream reconnect", created: now - 5 * 86_400_000, updated: now - 4 * 86_400_000, agent: "build-tellico-0" },
];

function replay(events: ServerEvent[], cut?: number) {
  const store = new Store();
  for (const e of cut === undefined ? events : events.slice(0, cut)) store.apply(e);
  const root = events.find((e) => e.type === "session.created" && !e.data.parentID)!.data.sessionID as string;
  return store.get(root);
}

function sessionMsg(events: ServerEvent[], cut?: number): HostToWebview {
  const { messages, ...meta } = replay(events, cut);
  return { type: "session", session: meta, from: 0, tail: messages };
}

/** Index just after the n-th event matching `type`, for mid-turn scenes. */
const after = (events: ServerEvent[], type: string, n = 1) => {
  let seen = 0;
  return events.findIndex((e) => e.type === type && ++seen === n) + 1;
};

const base: HostToWebview[] = [
  { type: "server", status: { kind: "ready" } },
  { type: "prefs", prefs },
  { type: "commands", commands },
  { type: "context", context: { file: "calc.py", selection: { start: 3, end: 9 } } },
  { type: "sessions", sessions },
];

const fr = fixAndRun as ServerEvent[];
const wd = workerDispatch as ServerEvent[];
const gi = guardAndInterrupt as ServerEvent[];

const scenes: Record<string, HostToWebview[]> = {
  welcome: [...base, { type: "noSession" }],
  starting: [{ type: "server", status: { kind: "starting" } }, { type: "prefs", prefs }, { type: "noSession" }],
  failed: [
    { type: "server", status: { kind: "failed", message: "The gateway rejected the API key. Set it again with \"Tellico: Set Gateway API Key\"." } },
    { type: "prefs", prefs },
    { type: "noSession" },
  ],
  "fix-and-run": [...base, sessionMsg(fr)],
  "fix-and-run-mid": [...base, sessionMsg(fr, after(fr, "session.text.delta", 20))],
  "worker-dispatch": [...base, sessionMsg(wd)],
  "worker-running": [...base, sessionMsg(wd, after(wd, "session.tool.success", 1) + 5)],
  "guard-and-interrupt": [...base, sessionMsg(gi)],
  history: [...base, sessionMsg(fr), { type: "showHistory" }],
};

(window as any).__SCENES = Object.keys(scenes);
const queue = scenes[sceneName] ?? scenes.welcome;

const sent: unknown[] = [];
(window as any).__SENT = sent;
(window as any).acquireVsCodeApi = () => {
  let state: unknown;
  return {
    postMessage(msg: any) {
      sent.push(msg);
      if (msg?.type === "ready") setTimeout(() => queue.forEach((data) => window.dispatchEvent(new MessageEvent("message", { data }))), 0);
    },
    getState: () => state,
    setState: (s: unknown) => (state = s),
  };
};
