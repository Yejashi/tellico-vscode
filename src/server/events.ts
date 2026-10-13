// One SSE subscription to GET /api/event. OpenCode's stream neither replays
// missed events nor reconnects by itself, so this reconnects with backoff and
// reports each (re)connect; the caller then refetches whatever it shows.

import { Api } from "./api";
import { ServerEvent } from "../state/reducer";

export interface EventStreamHandlers {
  onEvent(ev: ServerEvent): void;
  /** Fired on every successful (re)connect. `first` is false after a drop. */
  onConnected(first: boolean): void;
  onDisconnected(error: unknown): void;
}

export class EventStream {
  private abort?: AbortController;
  private stopped = false;
  private connectedOnce = false;

  constructor(private readonly api: Api, private readonly handlers: EventStreamHandlers) {}

  start() {
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  private async loop() {
    let delay = 250;
    while (!this.stopped) {
      try {
        await this.once();
        delay = 250;
      } catch (err) {
        if (this.stopped) return;
        this.handlers.onDisconnected(err);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  private async once() {
    this.abort = new AbortController();
    const res = await fetch(this.api.url("/api/event"), {
      headers: { Authorization: this.api.auth, Accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream: HTTP ${res.status}`);
    this.handlers.onConnected(!this.connectedOnce);
    this.connectedOnce = true;
    const parser = new SseParser((data) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      this.handlers.onEvent(ev);
    });
    const decoder = new TextDecoder();
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      parser.push(decoder.decode(chunk, { stream: true }));
    }
    throw new Error("event stream ended");
  }
}

/** Minimal text/event-stream parser: joins `data:` lines, dispatches on blank line. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  constructor(private readonly dispatch: (data: string) => void) {}

  push(text: string) {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length) this.dispatch(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(line[5] === " " ? 6 : 5));
      }
      // id:, event:, retry: and comments are not needed: the JSON carries its type.
    }
  }
}
