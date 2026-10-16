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
  /** MCP calls made from a Code Mode `execute` tool, as `<server>.<tool>`. */
  calls?: { tool: string; status: string }[];
  /** Epoch ms the call started and ended, for "ran for Ns". */
  started?: number;
  ended?: number;
}

export type Block = ReasoningBlock | TextBlock | ToolBlock;

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
  /** Names of attached files and images. */
  files?: string[];
  created: number;
}

/** Tokens one step (one model call) used, as the server reports them at its end. */
export interface StepTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

/**
 * Epoch ms of one step: the request went out, the first token arrived, the
 * stream ended. Live events and history give the same three points.
 */
export interface StepTiming {
  start: number;
  firstToken?: number;
  end?: number;
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
  tokens?: StepTokens;
  timing?: StepTiming;
}

export interface NoticeMessage {
  kind: "notice";
  id: string;
  /** warn: a guard plugin stepped in (loop guard, stall nudge). */
  level: "info" | "warn" | "error";
  text: string;
  created: number;
}

/** A command the user ran with `!`, outside any model turn. */
export interface ShellMessage {
  kind: "shell";
  id: string;
  command: string;
  status: "running" | "exited" | "timeout" | "killed";
  exit?: number;
  output?: string;
  created: number;
}

/** Where OpenCode or Magic Context summarised the conversation so far. */
export interface CompactionMessage {
  kind: "compaction";
  id: string;
  status: "running" | "completed" | "failed";
  reason?: string;
  summary?: string;
  created: number;
}

export type Message = UserMessage | AssistantMessage | NoticeMessage | ShellMessage | CompactionMessage;

/** A prompt queued behind the running turn: not part of the transcript until delivered. */
export interface PendingInput {
  id: string;
  text: string;
  delivery: "steer" | "queue";
  created: number;
}

/** A staged rewind: the transcript from `messageID` on is set aside and its files restored. */
export interface RevertState {
  messageID: string;
  /** Files the rewind restored, workspace-relative. */
  files: string[];
}

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
  /** Spend reported by the server, in USD; zero on the cluster. */
  cost?: number;
  /** Prompts waiting behind the running turn. */
  pending: PendingInput[];
  revert?: RevertState;
  /** A provider retry is scheduled: shown as a countdown until the next step. */
  retry?: { attempt: number; at: number; message: string };
  /** Set while a compaction runs. */
  compacting?: string;
  /** Free-form session metadata; `pinned` is the only key the UI uses. */
  pinned?: boolean;
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
    pending: [],
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
 * Tellico's guard plugins speak to the model as the user: loop-guard and the
 * stall nudge prefix their prompts like this. They read as notices, not as
 * something the user typed.
 */
export function guardNote(text: string): string | undefined {
  const m = /^\(Tellico(?: loop guard)?\)\s*/.exec(text);
  return m ? text : undefined;
}

/**
 * Magic Context tags each assistant message with a "§N§ " marker that the
 * model echoes back; it means nothing to a reader.
 */
export function stripMarkers(text: string): string {
  return text.replace(/^(\s*§\d+§\s*)+/, "");
}
