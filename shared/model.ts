// The conversation model shared by the extension host (which owns it) and the
// webview (which only renders it). It mirrors the shape OpenCode 2's
// GET /api/session/{id}/message returns, so history and live events build the
// same thing.

export type ThinkLevel = "off" | "low" | "medium" | "xhigh";
export const THINK_LEVELS: ThinkLevel[] = ["off", "low", "medium", "xhigh"];

export type Mode = "build" | "orchestrate";

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface ReasoningBlock {
  type: "reasoning";
  text: string;
  done: boolean;
  /** Epoch ms, from event timestamps; used for "Thought for Ns". */
  started?: number;
  ended?: number;
}

export interface TextBlock {
  type: "text";
  text: string;
  done: boolean;
}

export type ToolStatus = "pending" | "running" | "completed" | "error";

export interface ToolBlock {
  type: "tool";
  id: string;
  name: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  /** Child session started by a task/subagent tool, when known. */
  childSessionID?: string;
}

export type Block = ReasoningBlock | TextBlock | ToolBlock;

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
  files?: string[];
  created: number;
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  agent?: string;
  model?: ModelRef;
  blocks: Block[];
  created: number;
  done: boolean;
  finish?: string;
}

export interface NoticeMessage {
  kind: "notice";
  id: string;
  level: "info" | "error";
  text: string;
  created: number;
}

export type Message = UserMessage | AssistantMessage | NoticeMessage;

export interface PermissionRequest {
  id: string;
  sessionID: string;
  /** e.g. "external_directory", "bash", "edit" */
  action: string;
  /** Human-readable targets, e.g. paths or a command. */
  resources: string[];
  title?: string;
}

export interface FormQuestion {
  id: string;
  sessionID: string;
  title: string;
  raw: unknown;
}

export type SessionStatus = "idle" | "busy" | "error";

export interface ChildSession {
  id: string;
  title: string;
  agent?: string;
  status: SessionStatus;
}

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

export interface SessionView {
  id: string;
  title: string;
  parentID?: string;
  agent?: string;
  model?: ModelRef;
  status: SessionStatus;
  messages: Message[];
  permissions: PermissionRequest[];
  forms: FormQuestion[];
  children: ChildSession[];
  usage?: Usage;
  /** Files touched by edit tools this session (absolute paths). */
  changedFiles: string[];
  /** Line counts per changed file, from the server's diff when known. */
  fileStats?: Record<string, { additions: number; deletions: number }>;
  lastSeq: number;
}

export function emptySession(id: string): SessionView {
  return {
    id,
    title: "New session",
    status: "idle",
    messages: [],
    permissions: [],
    forms: [],
    children: [],
    changedFiles: [],
    lastSeq: 0,
  };
}

/** Tellico's primary agents are `build-tellico-N` / `orchestrate-tellico-N`. */
export function tellicoAgent(mode: Mode, node: 0 | 1): string {
  return `${mode}-tellico-${node}`;
}

export function parseTellicoAgent(agent: string | undefined): { mode: Mode; node: 0 | 1 } | undefined {
  const m = /^(build|orchestrate)-tellico-([01])$/.exec(agent ?? "");
  if (!m) return undefined;
  return { mode: m[1] as Mode, node: Number(m[2]) as 0 | 1 };
}

/**
 * Magic Context tags each assistant message with a "§N§ " marker that the
 * model echoes back; it means nothing to a reader.
 */
export function stripMarkers(text: string): string {
  return text.replace(/^(\s*§\d+§\s*)+/, "");
}
