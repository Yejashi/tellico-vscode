// The webview's link to the extension host: the VS Code API handle, and the
// host-owned state the webview renders, applied once per animation frame.

import { useEffect, useReducer } from "react";
import { push } from "./queue";
import type { Message } from "../shared/model";
import type {
  EditorContext,
  HostToWebview,
  McpServerView,
  Prefs,
  SavedPermissionView,
  ServerStatus,
  SessionMeta,
  SessionSummary,
  WebviewToHost,
} from "../shared/protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): any; setState(s: any): void };
export const vscode = acquireVsCodeApi();
export const post = (msg: WebviewToHost) => vscode.postMessage(msg);

/** Merges into the webview's persisted state (drafts, the session a tab shows). */
export function saveState(patch: Record<string, unknown>) {
  vscode.setState({ ...(vscode.getState() ?? {}), ...patch });
}

// ---------------- state ----------------

export type PanelName = "history" | "stats" | "mcp";

export interface State {
  server: ServerStatus;
  prefs?: Prefs;
  commands: { name: string; description?: string }[];
  context: EditorContext;
  session?: SessionMeta;
  messages: Message[];
  error?: { message: string; n: number };
  /** Text to add to (`replace: false`) or put in the composer. */
  insert?: { text: string; replace: boolean; n: number };
  sessions?: SessionSummary[];
  mcp: McpServerView[];
  savedPermissions?: SavedPermissionView[];
  fileMatches?: { query: string; items: { path: string; type: "file" | "directory" }[] };
  /** Bumped when the host asks for a panel (view title buttons, commands). */
  panel?: { name: PanelName; n: number };
  /** The host has said which session this view shows (or that it shows none). */
  known?: boolean;
}

export const initial: State = { server: { kind: "starting" }, commands: [], context: {}, messages: [], mcp: [] };

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
        s = { ...s, known: true, session: msg.session, messages: msg.from === 0 || same ? base.concat(msg.tail) : msg.tail, error: same ? s.error : undefined };
        break;
      }
      case "noSession":
        s = { ...s, known: true, session: undefined, messages: [], error: undefined };
        break;
      case "sessions":
        s = { ...s, sessions: msg.sessions };
        break;
      case "showPanel":
        s = { ...s, panel: { name: msg.panel, n: (s.panel?.n ?? 0) + 1 } };
        break;
      case "insertText":
        s = { ...s, insert: { text: msg.text, replace: false, n: (s.insert?.n ?? 0) + 1 } };
        break;
      case "setComposer":
        s = { ...s, insert: { text: msg.text, replace: true, n: (s.insert?.n ?? 0) + 1 } };
        break;
      case "fileMatches":
        s = { ...s, fileMatches: { query: msg.query, items: msg.items } };
        break;
      case "mcp":
        s = { ...s, mcp: msg.servers };
        break;
      case "savedPermissions":
        s = { ...s, savedPermissions: msg.items };
        break;
      case "error":
        s = { ...s, error: { message: msg.message, n: (s.error?.n ?? 0) + 1 } };
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
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      dispatch(batch);
    };
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      push(queue, e.data);
      // A hidden view gets no animation frames; keep applying, just less often.
      if (!frame) frame = document.hidden ? (setTimeout(flush, 250) as unknown as number) : requestAnimationFrame(flush);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return state;
}
