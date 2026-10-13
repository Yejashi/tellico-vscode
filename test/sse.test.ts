import { describe, expect, it } from "vitest";
import { SseParser } from "../src/server/events";

describe("SseParser", () => {
  it("handles events split across arbitrary chunk boundaries", () => {
    const out: string[] = [];
    const p = new SseParser((d) => out.push(d));
    const stream = 'id: 1\nevent: x\ndata: {"type":"a"}\n\ndata: {"type":"b"}\r\n\r\n: comment\n\n';
    for (const ch of stream) p.push(ch);
    expect(out).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("joins multi-line data", () => {
    const out: string[] = [];
    const p = new SseParser((d) => out.push(d));
    p.push("data: one\ndata:two\n\n");
    expect(out).toEqual(["one\ntwo"]);
  });
});
