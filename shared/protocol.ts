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
  created: number;
  updated: number;
  agent?: string;
  /** A turn is running right now. */
  busy?: boolean;
  /** Finished since it was last looked at. */
  unread?: boolean;
  pinned?: boolean;
}

/** Something attached to a prompt besides @-mentions in its text. */
export type Attachment =
  | { kind: "file"; path: string; range?: { start: number; end: number } }
  | { kind: "image"; name: string; dataUrl: string };

export interface McpServerView {
  name: string;
  status: "connected" | "pending" | "disabled" | "failed" | "needs_auth";
  error?: string;
  canAuth: boolean;
  /** The extension's own VS Code bridge, registered at runtime. */
  builtin?: boolean;
}

/** Config entries OpenCode silently misreads, per file (see lintConfig). */
export interface McpConfigIssues {
  file: string;
  scope: "project" | "global";
  issues: { name: string; problem: string }[];
}

export interface SavedPermissionView {
  id: string;
  action: string;
  resource: string;
}

export interface Prefs {
  mode: Mode;
  node: 0 | 1;
  think: ThinkLevel;
  attachActiveEditor: boolean;
  showReasoning: boolean;
  /** Pace streamed text like a chat app instead of showing token clusters as they land. */
  smoothStreaming?: boolean;
  /** Absolute workspace folder, for showing tool paths relative to it. */
  root?: string;
  /** How the models are reached right now, and whether the setting pins it. */
  connection?: "tunnel" | "gateway";
  connectionSetting?: "installed" | "tunnel" | "gateway";
  /** tellico.magicContext: whether the launcher loads the Magic Context plugin. */
  magicContext?: boolean;
  /** The model's context window and output cap, from the server. */
  contextLimit?: number;
  /** Whether the model accepts pasted images. */
  images?: boolean;
  /** Current git branch of the workspace. */
  branch?: string;
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
  /** Top-level sessions, most recent first, for the session browser. */
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "insertText"; text: string }
  /** Replace the composer's text (edit-and-resend, a rewind). */
  | { type: "setComposer"; text: string }
  | { type: "fileMatches"; query: string; items: { path: string; type: "file" | "directory" }[] }
  | { type: "mcp"; servers: McpServerView[]; issues?: McpConfigIssues[] }
  | { type: "savedPermissions"; items: SavedPermissionView[] }
  /** Open one of the webview's panels (view title buttons). */
  | { type: "showPanel"; panel: "history" | "stats" | "mcp" }
  | { type: "error"; message: string };

export type WebviewToHost =
  | { type: "ready" }
  /** `queue` waits for the running turn to end; `steer` joins it at the next step. */
  | { type: "send"; text: string; attachContext: boolean; delivery?: "steer" | "queue"; attachments?: Attachment[] }
  | { type: "command"; name: string; text: string }
  | { type: "interrupt" }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "deleteSession"; id: string }
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
  | { type: "showLogs" }
  /** Set the transcript aside from this user message on; `files` also restores the files. */
  | { type: "rewind"; messageID: string; files: boolean }
  /** Rewind to a user message and put its text back in the composer. */
  | { type: "editMessage"; messageID: string }
  | { type: "fork"; messageID: string }
  | { type: "revertUndo" }
  | { type: "revertCommit" }
  | { type: "pending"; id: string; action: "cancel" | "steer" }
  | { type: "compact" }
  | { type: "shell"; command: string }
  | { type: "renameSession"; id: string; title?: string }
  | { type: "pinSession"; id: string; pinned: boolean }
  | { type: "findFiles"; query: string }
  | { type: "pickFiles" }
  | { type: "stopWorker"; id: string }
  | { type: "mcpList" }
  | { type: "mcpToggle"; name: string; enable: boolean }
  | { type: "mcpAuth"; name: string }
  | { type: "mcpAdd" }
  | { type: "mcpImport" }
  | { type: "mcpOpenConfig" }
  /** Rewrite the misread entries of one OpenCode config file. */
  | { type: "mcpFixConfig"; file: string }
  | { type: "savedPermissions" }
  | { type: "removeSavedPermission"; id: string }
  | { type: "openSettings" };
