// Integration test against a plain `opencode serve` (no Tellico launcher, no
// model, no cluster slot): every route the extension uses that works without
// a model turn. It runs with throwaway XDG data/config directories, so it
// never touches the user's sessions or global config. Skipped when opencode
// is not installed (CI).

import { execFileSync, spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "../src/server/api";
import { EventStream } from "../src/server/events";
import { ServerEvent, Store } from "../src/state/reducer";
import { IdeMcpServer } from "../src/ide/mcpServer";
import { upsertServer } from "../src/mcp/config";

const opencode = (() => {
  try {
    return /\bv?2\.\d/.test(execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()) ? "opencode" : undefined;
  } catch {
    return undefined;
  }
})();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!opencode)("plain opencode serve", () => {
  const dir = mkdtempSync(join(tmpdir(), "tellico-oc-"));
  const home = mkdtempSync(join(tmpdir(), "tellico-oc-home-"));
  let proc: ChildProcess;
  let api: Api;
  let stream: EventStream;
  const events: ServerEvent[] = [];

  beforeAll(async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(join(dir, "README.md"), "# proj\n");
    const port = await freePort();
    proc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: dir,
      env: { ...process.env, OPENCODE_PASSWORD: "pw", XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache") },
      stdio: "ignore",
    });
    api = new Api({ baseUrl: `http://127.0.0.1:${port}`, password: "pw", directory: dir });
    for (let i = 0; i < 100; i++) {
      try {
        await api.agents();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    stream = new EventStream(api, { onEvent: (e) => events.push(e), onConnected: () => {}, onDisconnected: () => {} });
    stream.start();
    await new Promise((r) => setTimeout(r, 300));
  }, 60_000);

  afterAll(() => {
    stream?.stop();
    proc?.kill();
  });

  const waitFor = async (pred: () => boolean, ms = 10_000) => {
    for (let t = 0; t < ms && !pred(); t += 100) await new Promise((r) => setTimeout(r, 100));
    return pred();
  };

  it("finds files for @-mentions and reads the branch", async () => {
    let found: { path: string }[] = [];
    await waitFor(() => false, 1200); // the index settles about a second after start
    found = await api.findFiles("calc");
    expect(found.map((f) => f.path)).toContain("calc.py");
    expect((await api.vcs())?.branch).toBe("main");
  }, 15_000);

  it("runs a ! shell command with no model turn and builds the same message live and from history", async () => {
    // No model: a session for shell commands only.
    const { id } = await api.createSession("build", undefined as any);
    await api.shell(id, "echo hello-from-shell");
    expect(await waitFor(() => events.some((e) => e.type === "session.shell.ended" && e.data?.sessionID === id))).toBe(true);
    const live = new Store();
    for (const e of events) live.apply(e);
    const shell = live.get(id).messages.find((m) => m.kind === "shell");
    expect(shell).toMatchObject({ kind: "shell", command: "echo hello-from-shell", status: "exited", exit: 0 });
    expect((shell as any).output).toContain("hello-from-shell");
    const history = new Store().loadHistory(await api.sessionRaw(id), await api.messages(id));
    const h = history.messages.find((m) => m.kind === "shell");
    expect({ ...h, created: 0 }).toEqual({ ...shell, created: 0, id: h!.id });
  }, 20_000);

  it("renames, pins and lists a session; inbox and active are readable", async () => {
    const [s] = await api.sessions(1);
    await api.rename(s.id, "Renamed by test");
    await api.setMetadata(s.id, { pinned: true });
    const again = (await api.sessions(5)).find((x) => x.id === s.id)!;
    expect(again.title).toBe("Renamed by test");
    expect(again.pinned).toBe(true);
    expect(Array.isArray(await api.inbox(s.id))).toBe(true);
    expect(Array.isArray(await api.active())).toBe(true);
    expect(Array.isArray(await api.savedPermissions())).toBe(true);
  });

  it("registers the IDE bridge at runtime and sees it connect", async () => {
    const ide = new IdeMcpServer([{ name: "diagnostics", description: "test", inputSchema: { type: "object" }, call: async () => ({ text: "ok" }) }]);
    const { url, token } = await ide.start();
    try {
      await api.addMcp("vscode", { type: "remote", url, headers: { Authorization: `Bearer ${token}` }, codemode: false, oauth: false });
      let status = "";
      for (let i = 0; i < 50 && status !== "connected"; i++) {
        status = (await api.mcp()).find((m) => m.name === "vscode")?.status ?? "";
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe("connected");
      await api.disconnectMcp("vscode");
      expect((await api.mcp()).find((m) => m.name === "vscode")?.status).toBe("disabled");
      await api.removeMcp("vscode");
      expect((await api.mcp()).some((m) => m.name === "vscode")).toBe(false);
    } finally {
      await ide.stop();
    }
  }, 20_000);

  it("picks up an MCP server written into the project's opencode.json", async () => {
    const file = join(dir, "opencode.json");
    const text = upsertServer(existsSync(file) ? readFileSync(file, "utf8") : "", "probe", { type: "local", command: ["node", "-e", "process.stdin.resume()"] });
    writeFileSync(file, text);
    let names: string[] = [];
    for (let i = 0; i < 300 && !names.includes("probe"); i++) {
      names = (await api.mcp()).map((m) => m.name);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(names).toContain("probe");
  }, 40_000);

  it("never returns provider settings from defaultModel", async () => {
    const m = await api.defaultModel().catch(() => ({}));
    expect(JSON.stringify(m)).not.toMatch(/apiKey|settings/i);
  });
});
