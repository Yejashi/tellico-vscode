// The webview's link to the extension host: the VS Code API handle, and the
// host-owned state the webview renders, applied once per animation frame.

import { useEffect, useReducer } from "react";
import type { Message } from "../shared/model";
import type { EditorContext, HostToWebview, Prefs, ServerStatus, SessionMeta, SessionSummary, WebviewToHost } from "../shared/protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): any; setState(s: any): void };
export const vscode = acquireVsCodeApi();
export const post = (msg: WebviewToHost) => vscode.postMessage(msg);

// ---------------- state ----------------

export interface State {
  server: ServerStatus;
  prefs?: Prefs;
  commands: { name: string; description?: string }[];
  context: EditorContext;
  session?: SessionMeta;
  messages: Message[];
  error?: string;
  insert?: { text: string; n: number };
  sessions?: SessionSummary[];
  /** Bumped when the host asks for the session browser. */
  showHistory: number;
}

export const initial: State = { server: { kind: "starting" }, commands: [], context: {}, messages: [], showHistory: 0 };

export function reduce(state: State, batch: HostToWebview[]): State {
  let s = state;
  for (const msg of batch) {
    switch (msg.type) {
      case "server":
        s = { ...s, server: msg.status };
        break;
      case "prefs":
        s = { ...s, prefs: msg.prefs };
        break;
      case "commands":
        s = { ...s, commands: msg.commands };
        break;
      case "context":
        s = { ...s, context: msg.context };
        break;
      case "session": {
        const same = s.session?.id === msg.session.id;
        const base = same ? s.messages.slice(0, msg.from) : [];
        s = { ...s, session: msg.session, messages: msg.from === 0 || same ? base.concat(msg.tail) : msg.tail, error: undefined };
        break;
      }
      case "noSession":
        s = { ...s, session: undefined, messages: [], error: undefined };
        break;
      case "sessions":
        s = { ...s, sessions: msg.sessions };
        break;
      case "showHistory":
        s = { ...s, showHistory: s.showHistory + 1 };
        break;
      case "insertText":
        s = { ...s, insert: { text: msg.text, n: (s.insert?.n ?? 0) + 1 } };
        break;
      case "error":
        s = { ...s, error: msg.message };
        break;
    }
  }
  return s;
}

/** Host messages are applied once per animation frame, so bursts of token updates paint as one smooth frame. */
export function useHostState(): State {
  const [state, dispatch] = useReducer(reduce, initial);
  useEffect(() => {
    let queue: HostToWebview[] = [];
    let frame = 0;
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      queue.push(e.data);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const batch = queue;
          queue = [];
          dispatch(batch);
        });
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return state;
}
