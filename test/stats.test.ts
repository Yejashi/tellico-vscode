import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, ServerEvent } from "../src/state/reducer";
import { AssistantMessage } from "../shared/model";
import { sessionStats, stepRate, turnSummary } from "../shared/stats";

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function live(name: string) {
  const events: ServerEvent[] = load(name);
  const store = new Store();
  for (const e of events) store.apply(e);
  const id = events.find((e) => e.type === "session.created" && !e.data.parentID)!.data.sessionID as string;
  return store.get(id);
}

const steps = (ms: { kind: string }[]) => ms.filter((m): m is AssistantMessage => m.kind === "assistant");

describe("step timing and tokens", () => {
  const s = live("fix-and-run.events.json");
  const h = new Store().loadHistory({ id: s.id, title: s.title }, load("fix-and-run.messages.json").data);

  it("live events record tokens and timing for every step", () => {
    for (const m of steps(s.messages)) {
      expect(m.tokens?.output).toBeGreaterThan(0);
      expect(m.timing?.firstToken).toBeGreaterThan(m.timing!.start);
      expect(m.timing?.end).toBeGreaterThanOrEqual(m.timing!.firstToken!);
    }
  });

  it("history gives the same tokens and, within a few ms, the same timing", () => {
    const a = steps(s.messages);
    const b = steps(h.messages);
    expect(b.map((m) => m.tokens)).toEqual(a.map((m) => m.tokens));
    a.forEach((m, i) => {
      for (const k of ["start", "firstToken", "end"] as const) expect(Math.abs(b[i].timing![k]! - m.timing![k]!)).toBeLessThan(20);
    });
  });

  it("a step's decode rate is generated tokens over first token to end of stream", () => {
    const last = steps(s.messages).at(-1)!;
    const r = stepRate(last);
    const secs = (last.timing!.end! - last.timing!.firstToken!) / 1000;
    expect(r.decode).toBeCloseTo(last.tokens!.output / secs, 5);
    expect(r.ttft).toBe(last.timing!.firstToken! - last.timing!.start);
  });

  it("ignores rates from bursts too short to measure", () => {
    const m: AssistantMessage = { kind: "assistant", id: "x", blocks: [], created: 0, done: true, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0 }, timing: { start: 0, firstToken: 100, end: 120 } };
    expect(stepRate(m).decode).toBeUndefined();
    expect(stepRate(m).prefill).toBeUndefined();
  });
});

describe("session stats", () => {
  it("sums tokens, rates and tools across steps", () => {
    const s = live("fix-and-run.events.json");
    const st = sessionStats(s, s.messages);
    expect(st.turns).toBe(1);
    expect(st.steps).toBe(4);
    expect(st.tokens.output).toBe(105 + 144 + 133 + 72);
    expect(st.tokens.cacheRead).toBe(11178 + 11434 + 11592);
    expect(st.context).toBe(20 + 11592 + 72);
    expect(st.decode.avg).toBeGreaterThan(0);
    expect(st.decode.best).toBeGreaterThanOrEqual(st.decode.avg!);
    expect(st.tools.map((t) => t.name).sort()).toEqual(["edit", "read", "shell"]);
    expect(turnSummary(steps(s.messages))?.output).toBe(st.tokens.output);
  });

  it("counts secret-guard refusals", () => {
    const s = live("guard-and-interrupt.events.json");
    expect(sessionStats(s, s.messages).plugins.secretGuardBlocks).toBe(2);
  });

  it("counts worker dispatches and children", () => {
    const s = live("worker-dispatch.events.json");
    const st = sessionStats(s, s.messages);
    expect(st.plugins.dispatches).toBe(1);
    expect(st.workers).toEqual({ total: 1, running: 0, failed: 0 });
  });
});
