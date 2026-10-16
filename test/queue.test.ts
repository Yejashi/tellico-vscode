import { describe, expect, it } from "vitest";
import type { Message } from "../shared/model";
import type { HostToWebview } from "../shared/protocol";
import { push } from "../webview/queue";

// host.ts asks for the VS Code API when it loads.
(globalThis as any).acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });

const msg = (i: number): Message => ({ kind: "user", id: `m${i}`, text: `t${i}`, created: i });
const update = (from: number, tail: Message[]): HostToWebview => ({ type: "session", session: { id: "s" } as any, from, tail });

describe("webview inbox", () => {
  it("folds session updates so the result equals applying each one", async () => {
    const { reduce, initial } = await import("../webview/host");
    const updates = [
      update(0, [msg(0), msg(1)]),
      update(1, [msg(1), msg(2)]),
      update(2, [msg(2), msg(3), msg(4)]),
      update(4, [{ ...msg(4), text: "edited" }]),
      update(0, [msg(0)]), // a full resend replaces everything
      update(0, [msg(0), msg(9)]),
    ];
    const queue: HostToWebview[] = [];
    for (const u of updates) push(queue, u);
    expect(queue).toHaveLength(1);
    const oneByOne = updates.reduce((s, u) => reduce(s, [u]), initial);
    expect(reduce(initial, queue).messages).toEqual(oneByOne.messages);

    const q2: HostToWebview[] = [];
    for (const u of updates.slice(0, 4)) push(q2, u);
    expect(reduce(initial, q2).messages.map((m) => (m as any).text)).toEqual(["t0", "t1", "t2", "t3", "edited"]);
  });

  it("keeps other messages and other sessions in order", () => {
    const q: HostToWebview[] = [];
    push(q, update(0, [msg(0)]));
    push(q, { type: "server", status: { kind: "ready" } });
    push(q, update(1, [msg(1)]));
    expect(q.map((m) => m.type)).toEqual(["session", "server", "session"]);
  });
});
