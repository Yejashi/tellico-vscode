// Messages between the extension host and a chat webview. The host owns all
// state; the webview renders what it is sent and reports user intent.

import { Message, Mode, SessionView, ThinkLevel } from "./model";

export type ServerStatus =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export interface EditorContext {
  /** Workspace-relative path of the active editor's file. */
  file?: string;
  /** 1-based inclusive line range of a non-empty selection. */
  selection?: { start: number; end: number };
}

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
}

export interface Prefs {
  mode: Mode;
  node: 0 | 1;
  think: ThinkLevel;
  attachActiveEditor: boolean;
  showReasoning: boolean;
  /** Absolute workspace folder, for showing tool paths relative to it. */
  root?: string;
  /** How the models are reached right now, and whether the setting pins it. */
  connection?: "tunnel" | "gateway";
  connectionSetting?: "installed" | "tunnel" | "gateway";
}

/** Session metadata without the transcript. */
export type SessionMeta = Omit<SessionView, "messages">;

export type HostToWebview =
  | { type: "server"; status: ServerStatus }
  | { type: "prefs"; prefs: Prefs }
  | { type: "commands"; commands: { name: string; description?: string }[] }
  | { type: "context"; context: EditorContext }
  /**
   * The transcript from `from` onward replaces the webview's copy; messages
   * before it are unchanged. `from: 0` is a full replace. Streaming only ever
   * touches the tail, so a long session costs little per token.
   */
  | { type: "session"; session: SessionMeta; from: number; tail: Message[] }
  | { type: "noSession" }
  | { type: "insertText"; text: string }
  | { type: "error"; message: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string; attachContext: boolean }
  | { type: "command"; name: string; text: string }
  | { type: "interrupt" }
  | { type: "newSession" }
  | { type: "history" }
  | { type: "openSession"; id: string; inNewTab?: boolean }
  | { type: "setPrefs"; prefs: Partial<Pick<Prefs, "mode" | "node" | "think" | "attachActiveEditor" | "connectionSetting">> }
  | { type: "setGatewayKey" }
  | { type: "permission"; sessionID: string; requestID: string; decision: "once" | "always" | "reject" }
  | { type: "formReply"; sessionID: string; formID: string; answer: Record<string, unknown> }
  | { type: "formCancel"; sessionID: string; formID: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  | { type: "revertFile"; path: string }
  | { type: "copy"; text: string }
  | { type: "restartServer" }
  | { type: "showLogs" };
