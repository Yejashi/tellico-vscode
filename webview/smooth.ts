// Chat-app style text pacing. The server emits tokens in clusters (DFlash2
// speculative decoding accepts several drafted tokens per verify round, ~20-40
// ms apart) and the network adds the odd pause; revealing the received text at
// a rate that follows the backlog turns both into a steady flow.
//
// Pure functions only, so the pacing is unit-tested without a DOM.

export interface Pace {
  /** Time constant for closing the backlog while the model is still writing (ms). */
  tau: number;
  /** Faster time constant once the block is complete, so the end never lingers (ms). */
  doneTau: number;
  /** Floor on the reveal speed, so a small backlog still moves (chars per second). */
  minRate: number;
  /** Higher floor once the block is complete: the tail should finish, not crawl. */
  doneMinRate: number;
}

export const DEFAULT_PACE: Pace = { tau: 160, doneTau: 70, minRate: 60, doneMinRate: 1500 };

/**
 * How many characters (fractional) to show after `dtMs` more milliseconds.
 * The step is the larger of an exponential approach to the target -- a big
 * burst drains quickly at first and eases in -- and a constant floor, so it
 * never stalls on the last few characters. It never overshoots.
 */
export function advance(shown: number, target: number, dtMs: number, done: boolean, pace: Pace = DEFAULT_PACE): number {
  if (shown >= target) return target;
  const backlog = target - shown;
  const tau = done ? pace.doneTau : pace.tau;
  const approach = backlog * (1 - Math.exp(-dtMs / tau));
  const floor = ((done ? pace.doneMinRate : pace.minRate) * dtMs) / 1000;
  return Math.min(target, shown + Math.max(approach, floor));
}

/** A cut position that does not split a UTF-16 surrogate pair (emoji, CJK ext.). */
export function safeCut(text: string, n: number): number {
  if (n <= 0) return 0;
  if (n >= text.length) return text.length;
  const c = text.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
}

/**
 * Magic Context prefixes replies with a "§N§" tag that is stripped before
 * display. Mid-stream the tag can be incomplete ("§1", "§12"), which the
 * stripper cannot recognise yet; hide it rather than flash it.
 */
export function hidePartialMarker(text: string): string {
  return /^\s*§\d*$/.test(text) ? "" : text;
}
