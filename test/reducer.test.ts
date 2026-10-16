import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, ServerEvent } from "../src/state/reducer";
import { AssistantMessage, parseTellicoAgent, stripMarkers, ToolBlock } from "../shared/model";

// Recorded from a real `opencode-tellico serve` (OpenCode 2.0.26) on
// 2026-10-13; see test/fixtures/README.md.
const load = (name: string): ServerEvent[] =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function replay(events: ServerEvent[]): Store {
  const store = new Store();
  for (const e of events) store.apply(e);
  return store;
}

const rootOf = (events: ServerEvent[]) =>
  events.find((e) => e.type === "session.created" && !e.data.parentID)!.data.sessionID as string;

describe("fix-and-run: read, edit, shell, answer", () => {
  const events = load("fix-and-run.events.json");
  const store = replay(events);
  const s = store.get(rootOf(events));

  it("ends idle with the generated title", () => {
    expect(s.status).toBe("idle");
    expect(s.title).toBe("Fixing add() bug in calc.py");
  });

  it("orders user prompt, then assistant steps", () => {
    expect(s.messages[0].kind).toBe("user");
    const assistants = s.messages.filter((m): m is AssistantMessage => m.kind === "assistant");
    expect(assistants.length).toBe(4);
    expect(assistants.every((m) => m.done)).toBe(true);
  });

  it("captures the three tools with inputs and outputs", () => {
    const tools = s.messages.flatMap((m) => (m.kind === "assistant" ? m.blocks : [])).filter((b): b is ToolBlock => b.type === "tool");
    expect(tools.map((t) => t.name)).toEqual(["read", "edit", "shell"]);
    expect(tools.every((t) => t.status === "completed")).toBe(true);
    expect(tools[2].output).toBe("5\n");
    expect(s.changedFiles).toEqual(["/work/proj/calc.py"]);
  });

  it("assembles streamed text identical to the final text", () => {
    const last = s.messages.at(-1) as AssistantMessage;
    const text = last.blocks.find((b) => b.type === "text")!;
    expect(stripMarkers(text.text)).toContain("the command output is **5**");
  });

  it("history produces the same transcript shape as live events", () => {
    const history = JSON.parse(readFileSync(join(__dirname, "fixtures", "fix-and-run.messages.json"), "utf8"));
    const h = new Store().loadHistory({ id: s.id, title: s.title }, history.data);
    const kinds = (ms: typeof s.messages) => ms.map((m) => m.kind);
    expect(kinds(h.messages)).toEqual(kinds(s.messages));
    const toolNames = h.messages.flatMap((m) => (m.kind === "assistant" ? m.blocks : [])).filter((b) => b.type === "tool").map((b) => (b as ToolBlock).name);
    expect(toolNames).toEqual(["read", "edit", "shell"]);
    expect(h.changedFiles).toEqual(["/work/proj/calc.py"]);
  });
});

describe("worker-dispatch: background subagent", () => {
  const events = load("worker-dispatch.events.json");
  const store = replay(events);
  const lead = store.get(rootOf(events));

  it("lists the worker as a finished child of the lead", () => {
    expect(lead.children).toHaveLength(1);
    expect(lead.children[0]).toMatchObject({ agent: "tellico-worker-0", status: "idle", title: "Count lines in calc.py" });
  });

  it("links the subagent tool call to the child session", () => {
    const t = lead.messages.flatMap((m) => (m.kind === "assistant" ? m.blocks : [])).find((b): b is ToolBlock => b.type === "tool" && b.name === "subagent");
    expect(t?.childSessionID).toBe(lead.children[0].id);
  });

  it("shows the completion notice in the lead transcript", () => {
    expect(lead.messages.some((m) => m.kind === "notice" && m.text.includes("completed"))).toBe(true);
  });

  it("rolls a worker's edits up into the lead's changed files", () => {
    const store = new Store();
    store.apply({ type: "session.created", data: { sessionID: "ses_w", parentID: "ses_l", agent: "tellico-worker-0" } });
    store.apply({ type: "session.tool.input.started", data: { sessionID: "ses_w", assistantMessageID: "msg_1", id: "t1", name: "edit" } });
    store.apply({ type: "session.tool.called", data: { sessionID: "ses_w", assistantMessageID: "msg_1", id: "t1", input: { path: "/work/proj/a.py" } } });
    const changed = store.apply({ type: "session.tool.success", data: { sessionID: "ses_w", assistantMessageID: "msg_1", id: "t1", content: [] } });
    expect(changed).toEqual(["ses_w", "ses_l"]);
    expect(store.get("ses_l").changedFiles).toEqual(["/work/proj/a.py"]);
  });

  it("keeps the child's own transcript", () => {
    const child = store.get(lead.children[0].id);
    expect(child.parentID).toBe(lead.id);
    expect(child.status).toBe("idle");
  });
});

describe("guard-and-interrupt: blocked tool and a user interrupt", () => {
  const events = load("guard-and-interrupt.events.json");
  const s = replay(events).get(rootOf(events));

  it("records secret-guard's refusal as a tool error", () => {
    const failed = s.messages.flatMap((m) => (m.kind === "assistant" ? m.blocks : [])).filter((b): b is ToolBlock => b.type === "tool" && b.status === "error");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error).toContain("[secret-guard] blocked");
  });

  it("ends idle with an interrupted notice and no running tools", () => {
    expect(s.status).toBe("idle");
    expect(s.messages.some((m) => m.kind === "notice" && m.text === "Interrupted.")).toBe(true);
    const running = s.messages.flatMap((m) => (m.kind === "assistant" ? m.blocks : [])).filter((b) => b.type === "tool" && (b.status === "running" || b.status === "pending"));
    expect(running).toHaveLength(0);
  });
});

describe("permissions (shape from the OpenAPI Permission.Request)", () => {
  it("adds and clears a pending request", () => {
    const store = new Store();
    const req = { id: "per_1", sessionID: "ses_a", action: "bash", resources: ["rm -rf build"] };
    expect(store.apply({ type: "permission.asked", data: req })).toEqual(["ses_a"]);
    expect(store.get("ses_a").permissions).toEqual([{ ...req, title: undefined }]);
    store.apply({ type: "permission.replied", data: { sessionID: "ses_a", requestID: "per_1" } });
    expect(store.get("ses_a").permissions).toEqual([]);
  });

  it("surfaces a child's request on the parent too", () => {
    const store = new Store();
    store.apply({ type: "session.created", data: { sessionID: "ses_c", parentID: "ses_p", agent: "tellico-worker-1" } });
    const changed = store.apply({ type: "permission.asked", data: { request: { id: "per_2", sessionID: "ses_c", action: "edit", resources: ["a.ts"] } } });
    expect(changed).toEqual(["ses_c", "ses_p"]);
  });

  it("ignores malformed requests instead of throwing", () => {
    expect(new Store().apply({ type: "permission.asked", data: { nope: true } })).toEqual([]);
  });
});

describe("helpers", () => {
  it("parses Tellico agent names only", () => {
    expect(parseTellicoAgent("orchestrate-tellico-1")).toEqual({ mode: "orchestrate", node: 1 });
    expect(parseTellicoAgent("tellico-worker-0")).toBeUndefined();
    expect(parseTellicoAgent("orchestrate-local")).toBeUndefined();
  });

  it("strips Magic Context markers", () => {
    expect(stripMarkers("§4§ `calc.py` had")).toBe("`calc.py` had");
    expect(stripMarkers("no marker §1§ inside")).toBe("no marker §1§ inside");
  });
});

describe("inbox: queue and steer", () => {
  const enqueue = (delivery: "steer" | "queue", id = "msg_q1") => ({
    type: "session.inbox.enqueued",
    data: { sessionID: "ses_a", inboxID: id, item: { type: "user", payload: { text: "and then add tests" }, delivery } },
  });

  it("keeps a queued prompt out of the transcript until it is delivered", () => {
    const store = new Store();
    store.apply(enqueue("queue"));
    const s = store.get("ses_a");
    expect(s.pending).toEqual([expect.objectContaining({ id: "msg_q1", delivery: "queue" })]);
    expect(s.messages).toHaveLength(0);
    store.apply({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_q1" } });
    expect(s.pending).toHaveLength(0);
    expect(s.messages).toEqual([expect.objectContaining({ kind: "user", id: "msg_q1", text: "and then add tests" })]);
  });

  it("drops a cancelled prompt and tracks a switch to steer", () => {
    const store = new Store();
    store.apply(enqueue("queue", "msg_a"));
    store.apply(enqueue("queue", "msg_b"));
    store.apply({ type: "session.inbox.delivery.changed", data: { sessionID: "ses_a", inboxID: "msg_b", delivery: "steer" } });
    store.apply({ type: "session.inbox.cancelled", data: { sessionID: "ses_a", inboxID: "msg_a" } });
    expect(store.get("ses_a").pending).toEqual([expect.objectContaining({ id: "msg_b", delivery: "steer" })]);
  });

  it("shows a steered prompt at once", () => {
    const store = new Store();
    store.apply(enqueue("steer"));
    expect(store.get("ses_a").messages.map((m) => m.kind)).toEqual(["user"]);
  });

  it("loads only undelivered queued prompts from the inbox route", () => {
    const store = new Store();
    store.loadInbox("ses_a", [
      { id: "msg_1", type: "user", delivery: "queue", payload: { text: "later" }, time: { created: 1 } },
      { id: "msg_2", type: "synthetic", delivery: "queue", payload: { text: "x" } },
    ]);
    expect(store.get("ses_a").pending.map((p) => p.id)).toEqual(["msg_1"]);
  });
});

describe("guard plugin notes", () => {
  it("renders loop-guard and stall prompts as warnings, not user bubbles", () => {
    const store = new Store();
    const text = "(Tellico loop guard) Your last reply began repeating the same paragraph.";
    store.apply({ type: "session.inbox.enqueued", data: { sessionID: "ses_a", inboxID: "msg_g", item: { type: "user", payload: { text }, delivery: "steer" } } });
    const h = new Store().loadHistory({ id: "ses_b" }, [{ id: "msg_h", type: "user", text: '(Tellico) Your last reply ended with "Next I will run the tests" but made no tool call.', time: { created: 1 } }]);
    expect(store.get("ses_a").messages[0]).toMatchObject({ kind: "notice", level: "warn", text: "Your last reply began repeating the same paragraph." });
    expect(h.messages[0]).toMatchObject({ kind: "notice", level: "warn" });
  });
});

describe("interrupts, retries, revert, shell, compaction", () => {
  it("reports an interrupt once, with its reason", () => {
    const events = load("guard-and-interrupt.events.json");
    const s = replay(events).get(rootOf(events));
    expect(s.messages.filter((m) => m.kind === "notice").map((m) => (m as any).text)).toEqual(["Interrupted."]);
    const store = new Store();
    store.apply({ type: "session.execution.interrupted", data: { sessionID: "ses_a", reason: "inactivity" } });
    expect(store.get("ses_a").messages[0]).toMatchObject({ text: "Stopped after a long stretch with no progress." });
  });

  it("holds a retry as state until the next step starts", () => {
    const store = new Store();
    store.apply({ type: "session.retry.scheduled", data: { sessionID: "ses_a", attempt: 2, at: 5000, error: { type: "provider.transport", message: "The cluster is busy" } } });
    expect(store.get("ses_a").retry).toEqual({ attempt: 2, at: 5000, message: "The cluster is busy" });
    expect(store.get("ses_a").messages).toHaveLength(0);
    store.apply({ type: "session.step.started", data: { sessionID: "ses_a", assistantMessageID: "msg_x" } });
    expect(store.get("ses_a").retry).toBeUndefined();
  });

  it("stages, clears and commits a rewind", () => {
    const events = load("fix-and-run.events.json");
    const store = replay(events);
    const id = rootOf(events);
    const s = store.get(id);
    const user = s.messages[0].id;
    store.apply({ type: "session.revert.staged", data: { sessionID: id, revert: { messageID: user, files: [{ file: "calc.py" }] } } });
    expect(s.revert).toEqual({ messageID: user, files: ["calc.py"] });
    store.apply({ type: "session.revert.cleared", data: { sessionID: id } });
    expect(s.revert).toBeUndefined();
    store.apply({ type: "session.revert.staged", data: { sessionID: id, revert: { messageID: user } } });
    store.apply({ type: "session.revert.committed", data: { sessionID: id, to: user } });
    expect(s.messages).toHaveLength(0);
    expect(s.revert).toBeUndefined();
  });

  it("builds a shell message from live events and from history alike", () => {
    const store = new Store();
    const shell = { id: "sh_1", command: "git status", status: "running" };
    store.apply({ type: "session.shell.started", data: { sessionID: "ses_a", shell } });
    store.apply({ type: "session.shell.ended", data: { sessionID: "ses_a", shell: { ...shell, status: "exited", exit: 0 }, output: { output: "clean\n" } } });
    const live = store.get("ses_a").messages;
    const h = new Store().loadHistory({ id: "ses_b" }, [{ id: "msg_9", type: "shell", shellID: "sh_1", command: "git status", status: "exited", exit: 0, output: { output: "clean\n" }, time: { created: 1 } }]);
    expect(live).toHaveLength(1);
    expect({ ...live[0], created: 0 }).toEqual({ ...h.messages[0], created: 0 });
  });

  it("marks compaction while it runs and leaves a divider after", () => {
    const store = new Store();
    store.apply({ type: "session.compaction.started", data: { sessionID: "ses_a", reason: "manual" } });
    expect(store.get("ses_a").compacting).toBe("manual");
    store.apply({ type: "session.compaction.ended", data: { sessionID: "ses_a", reason: "manual", text: "summary" } });
    expect(store.get("ses_a").compacting).toBeUndefined();
    expect(store.get("ses_a").messages[0]).toMatchObject({ kind: "compaction", status: "completed", summary: "summary" });
  });

  it("collects Code Mode MCP calls on the execute tool", () => {
    const store = new Store();
    const base = { sessionID: "ses_a", assistantMessageID: "msg_1", id: "t1" };
    store.apply({ type: "session.tool.input.started", data: { ...base, name: "execute" } });
    store.apply({ type: "session.tool.progress", data: { ...base, metadata: { toolCalls: [{ tool: "github.search_issues", status: "running" }] } } });
    const t = (store.get("ses_a").messages[0] as AssistantMessage).blocks[0] as ToolBlock;
    expect(t.calls).toEqual([{ tool: "github.search_issues", status: "running" }]);
  });
});
