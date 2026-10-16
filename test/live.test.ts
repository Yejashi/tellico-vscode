// End-to-end smoke test against a real `opencode-tellico serve`. It uses a
// cluster slot, so it never runs in CI: `TELLICO_LIVE=1 npx vitest run test/live.test.ts`,
// optionally with TELLICO_LIVE_CONNECTION=tunnel or gateway.
// Needs an installed tellico-agentic-setup client and a writable scratch dir.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Api } from "../src/server/api";
import { EventStream } from "../src/server/events";
import { ServerManager } from "../src/server/manager";
import { Store } from "../src/state/reducer";
import { reversePatch } from "../src/diff/patch";
import { buildPromptFiles } from "../src/prompt";
import { existsSync } from "node:fs";

const live = process.env.TELLICO_LIVE === "1";

describe.skipIf(!live)("live opencode-tellico serve", () => {
  it("starts, streams a turn that edits a file, and rebuilds the original from /diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tellico-smoke-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");

    const logs: string[] = [];
    const manager = new ServerManager(dir, () => ({
      launcherPath: "opencode-tellico",
      leadNode: "auto",
      magicContext: true,
      backgroundSubagents: false,
      // TELLICO_LIVE_CONNECTION=tunnel|gateway runs the same test over either.
      connection: (process.env.TELLICO_LIVE_CONNECTION as "tunnel" | "gateway" | undefined) ?? "installed",
      gatewayUrl: "",
      websearch: "default",
      steps: 0,
      loopGuard: true,
      remoteControl: "installed",
    }), {
      onState: () => {},
      onLog: (l) => logs.push(l),
    });
    const conn = await manager.start();
    try {
      const api = new Api(conn);
      const node = await api.defaultNode();
      expect(node === 0 || node === 1).toBe(true);
      const agents = await api.agents();
      const lead = agents.find((a) => a.id === `build-tellico-${node}`)!;
      expect(lead.modelID).toBeTruthy();
      expect(JSON.stringify(agents)).not.toMatch(/apiKey/i);

      const store = new Store();
      const deltas: number[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => (resolveDone = r));
      let sid = "";
      const stream = new EventStream(api, {
        onEvent: (ev) => {
          store.apply(ev);
          if (ev.type === "session.text.delta" && ev.data.sessionID === sid) deltas.push(Date.now());
          if (ev.data?.sessionID === sid && /^session\.execution\.(succeeded|failed)$/.test(ev.type)) resolveDone();
        },
        onConnected: () => {},
        onDisconnected: () => {},
      });
      stream.start();
      await new Promise((r) => setTimeout(r, 300));

      const info = await api.createSession(lead.id, { id: lead.modelID!, providerID: lead.providerID!, variant: "low" });
      sid = info.id;
      // Attached through an @-mention, as the composer sends it.
      const text = "@calc.py has a bug in add(). Fix it with the edit tool. Then answer in one short sentence.";
      const files = buildPromptFiles({ text, root: dir, exists: existsSync });
      expect(files).toHaveLength(1);
      await api.prompt(sid, text, files);
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 240_000))]);
      stream.stop();

      const s = store.get(sid);
      expect(s.status).toBe("idle");
      expect(s.changedFiles.map((p) => p.replace(dir + "/", ""))).toContain("calc.py");
      expect(deltas.length).toBeGreaterThan(0);

      const now = readFileSync(join(dir, "calc.py"), "utf8");
      expect(now).toContain("a + b");
      const users = s.messages.filter((m) => m.kind === "user");
      const diff = (await api.diff(sid, { from: users[0].id, to: users[users.length - 1].id })).find((d) => d.file === "calc.py")!;
      expect(reversePatch(now, diff.patch)).toBe("def add(a, b):\n    return a - b\n");

      const history = new Store().loadHistory(await api.sessionRaw(sid), await api.messages(sid));
      expect(history.messages.filter((m) => m.kind === "assistant").length).toBe(
        s.messages.filter((m) => m.kind === "assistant").length,
      );
      expect(history.messages.find((m) => m.kind === "user")).toMatchObject({ files: ["calc.py"] });

      // Rewind to before the prompt restores the file; redo puts the fix back.
      const restored = await api.revertStage(sid, users[0].id, true);
      expect(restored.files).toContain("calc.py");
      expect(readFileSync(join(dir, "calc.py"), "utf8")).toBe("def add(a, b):\n    return a - b\n");
      expect((await api.sessionRaw(sid)).revert?.messageID).toBe(users[0].id);
      await api.revertClear(sid);
      expect(readFileSync(join(dir, "calc.py"), "utf8")).toBe(now);
    } finally {
      manager.stop();
    }
  }, 300_000);
});
