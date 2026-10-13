import { describe, expect, it } from "vitest";
import { advance, DEFAULT_PACE, hidePartialMarker, safeCut } from "../webview/smooth";

/** Simulates frames at 60 fps while tokens arrive on a schedule; returns chars shown per frame. */
function simulate(arrivals: { atMs: number; chars: number }[], totalMs: number, doneAtMs = Infinity) {
  let shown = 0;
  let target = 0;
  const perFrame: number[] = [];
  const dt = 1000 / 60;
  for (let t = 0; t < totalMs; t += dt) {
    for (const a of arrivals) if (a.atMs > t - dt && a.atMs <= t) target += a.chars;
    const before = Math.floor(shown);
    shown = advance(shown, target, dt, t >= doneAtMs);
    perFrame.push(Math.floor(shown) - before);
  }
  return { perFrame, shown, target };
}

describe("advance", () => {
  it("never overshoots and reaches the target", () => {
    let s = 0;
    for (let i = 0; i < 200; i++) s = advance(s, 100, 16.7, false);
    expect(s).toBe(100);
    expect(advance(100, 100, 16.7, false)).toBe(100);
  });

  it("spreads speculative-decoding bursts over frames instead of dumping them", () => {
    // DFlash2-like output: a 24-char cluster every 35 ms (~5 tokens/round).
    const arrivals = Array.from({ length: 40 }, (_, i) => ({ atMs: i * 35, chars: 24 }));
    const { perFrame } = simulate(arrivals, 1400);
    const active = perFrame.slice(5, 70);
    // Raw, every frame with a burst would jump by 24 and the frames between
    // would be empty; paced, the text moves on nearly every frame and no
    // single frame takes a whole burst.
    expect(active.filter((n) => n === 0).length).toBeLessThan(active.length * 0.1);
    expect(Math.max(...active)).toBeLessThan(24);
  });

  it("keeps up with sustained output instead of falling behind", () => {
    // 200 tok/s at ~4 chars/token = 800 chars/s for 3 s.
    const arrivals = Array.from({ length: 600 }, (_, i) => ({ atMs: i * 5, chars: 4 }));
    const { shown, target } = simulate(arrivals, 3000);
    // Lag stays a fraction of a second's worth of text.
    expect(target - shown).toBeLessThan(800 * 0.3);
  });

  it("finishes quickly once the block is done", () => {
    const { shown, target } = simulate([{ atMs: 0, chars: 600 }], 400, 0);
    expect(shown).toBe(target);
  });

  it("covers a network pause by still moving through the backlog", () => {
    // Burst, then a 250 ms gap (seen on the tunnel), then more text.
    const { perFrame } = simulate([{ atMs: 0, chars: 120 }, { atMs: 250, chars: 120 }], 600);
    const duringGap = perFrame.slice(3, 15);
    expect(duringGap.every((n) => n > 0)).toBe(true);
  });

  it("uses the minimum rate for a tiny backlog", () => {
    const step = advance(0, 2, 1000 / 60, false) - 0;
    expect(step).toBeGreaterThanOrEqual((DEFAULT_PACE.minRate / 60) * 0.99);
  });
});

describe("helpers", () => {
  it("does not split a surrogate pair", () => {
    const s = "a😀b";
    expect(safeCut(s, 2)).toBe(3);
    expect(safeCut(s, 1)).toBe(1);
    expect(safeCut(s, 99)).toBe(s.length);
  });

  it("hides an incomplete Magic Context tag at the start", () => {
    expect(hidePartialMarker("§1")).toBe("");
    expect(hidePartialMarker(" §12")).toBe("");
    expect(hidePartialMarker("§1§ hi")).toBe("§1§ hi");
    expect(hidePartialMarker("costs §5")).toBe("costs §5");
  });
});
