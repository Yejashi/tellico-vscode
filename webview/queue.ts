// The webview's inbox from the host, folded so it cannot grow while frames
// are held back. Pure, so it is unit-tested.

import type { HostToWebview } from "../shared/protocol";

/**
 * Queues a host message, folding a session update into the one before it:
 * while frames are held back (a hidden view) the queue stays one message per
 * session instead of one per 33 ms flush.
 */
export function push(queue: HostToWebview[], msg: HostToWebview) {
  const last = queue[queue.length - 1];
  if (msg.type === "session" && last?.type === "session" && last.session.id === msg.session.id) {
    if (msg.from >= last.from) {
      queue[queue.length - 1] = { ...msg, from: last.from, tail: last.tail.slice(0, msg.from - last.from).concat(msg.tail) };
      return;
    }
    queue[queue.length - 1] = msg;
    return;
  }
  queue.push(msg);
}
