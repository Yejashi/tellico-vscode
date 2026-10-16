// Turns OpenCode 2 server events and history into SessionView objects.
// Pure functions only: no vscode import, so the whole thing is unit-testable
// against recorded event streams (test/fixtures).

import {
  AssistantMessage,
  Block,
  ChildSession,
  emptySession,
  FormQuestion,
  guardNote,
  Message,
  ModelRef,
  PermissionRequest,
  ReasoningBlock,
  SessionStatus,
  ShellMessage,
  TextBlock,
  SessionView,
  StepTokens,
  ToolBlock,
} from "../../shared/model";

/** One event from GET /api/event, after JSON parsing. */
export interface ServerEvent {
  id?: string;
  type: string;
  created?: number;
  data?: any;
  durable?: { aggregateID: string; seq: number };
}

export class Store {
  readonly sessions = new Map<string, SessionView>();

  get(id: string): SessionView {
    let s = this.sessions.get(id);
    if (!s) {
      s = emptySession(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  /**
   * Applies one event. Returns the ids of sessions whose view changed, so
   * the caller only re-sends those.
   */
  apply(ev: ServerEvent): string[] {
    const d = ev.data ?? {};
    const sid: string | undefined = d.sessionID;
    const now = ev.created ?? Date.now();

    switch (ev.type) {
      case "session.created": {
        const s = this.get(sid!);
        s.agent = d.agent ?? s.agent;
        s.model = d.model ?? s.model;
        if (d.title) s.title = d.title;
        if (d.parentID) {
          s.parentID = d.parentID;
          const parent = this.get(d.parentID);
          upsertChild(parent, { id: sid!, title: d.title ?? "Subagent", agent: d.agent, status: "busy" });
          return [sid!, d.parentID];
        }
        return [sid!];
      }
      case "session.renamed": {
        const s = this.get(sid!);
        s.title = d.title ?? s.title;
        return withParent(this, s, (p) => upsertChild(p, { id: s.id, title: s.title }));
      }
      case "session.agent.selected": {
        const s = this.get(sid!);
        if (d.agent) s.agent = d.agent;
        return [s.id];
      }
      case "session.model.selected": {
        const s = this.get(sid!);
        if (d.model) s.model = d.model;
        return [s.id];
      }
      case "session.deleted": {
        if (sid) this.sessions.delete(sid);
        return sid ? [sid] : [];
      }
      case "session.metadata.updated": {
        const s = this.get(sid!);
        s.pinned = Boolean(d.metadata?.pinned);
        return [s.id];
      }
      case "session.inbox.enqueued": {
        const s = this.get(sid!);
        const item = d.item ?? {};
        if (item.type === "user" && typeof item.payload?.text === "string") {
          const id = d.inboxID as string;
          // A queued prompt waits behind the turn; it joins the transcript when delivered.
          if (item.delivery === "queue") {
            s.pending = s.pending.filter((p) => p.id !== id).concat({ id, text: item.payload.text, delivery: "queue", created: now });
            return [s.id];
          }
          s.messages = s.messages.filter((m) => !(m.kind === "user" && m.id === id));
          s.messages.push(userMessage(id, item.payload, now));
        } else if (item.type === "synthetic" && item.payload?.metadata?.source === "subagent") {
          const md = item.payload.metadata;
          s.messages.push({
            kind: "notice",
            id: d.inboxID,
            level: md.state === "completed" ? "info" : "error",
            text: `Worker ${md.agent ?? ""} ${md.state ?? "finished"}: ${item.payload.description ?? ""}`.trim(),
            created: now,
          });
          upsertChild(s, { id: md.childID, title: item.payload.description ?? "Subagent", status: md.state === "completed" ? "idle" : "error" });
        }
        return [s.id];
      }
      case "session.inbox.delivered": {
        const s = this.get(sid!);
        const p = s.pending.find((x) => x.id === d.inboxID);
        if (!p) return [];
        s.pending = s.pending.filter((x) => x !== p);
        if (!s.messages.some((m) => m.id === p.id)) s.messages.push(userMessage(p.id, { text: p.text }, now));
        return [s.id];
      }
      case "session.inbox.cancelled": {
        const s = this.get(sid!);
        const before = s.pending.length;
        s.pending = s.pending.filter((x) => x.id !== d.inboxID);
        return s.pending.length !== before ? [s.id] : [];
      }
      case "session.inbox.delivery.changed": {
        const s = this.get(sid!);
        const p = s.pending.find((x) => x.id === d.inboxID);
        if (!p) return [];
        p.delivery = d.delivery === "steer" ? "steer" : "queue";
        return [s.id];
      }
      case "session.revert.staged": {
        const s = this.get(sid!);
        const r = d.revert ?? {};
        if (typeof r.messageID === "string") s.revert = { messageID: r.messageID, files: (r.files ?? []).map((f: any) => String(f.file)) };
        return [s.id];
      }
      case "session.revert.cleared": {
        const s = this.get(sid!);
        s.revert = undefined;
        return [s.id];
      }
      case "session.revert.committed": {
        const s = this.get(sid!);
        const at = s.messages.findIndex((m) => m.id === (d.to ?? s.revert?.messageID));
        if (at >= 0) s.messages = s.messages.slice(0, at);
        s.revert = undefined;
        return [s.id];
      }
      case "session.compaction.started": {
        const s = this.get(sid!);
        s.compacting = d.reason ?? "auto";
        return [s.id];
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const s = this.get(sid!);
        s.compacting = undefined;
        const failed = ev.type === "session.compaction.failed";
        s.messages.push({ kind: "compaction", id: `compaction-${now}`, status: failed ? "failed" : "completed", reason: d.reason, summary: failed ? errorText(d) : d.text, created: now });
        return [s.id];
      }
      case "session.shell.started":
      case "session.shell.ended": {
        const s = this.get(sid!);
        const sh = d.shell ?? {};
        const id = String(sh.id ?? `shell-${now}`);
        const existing = s.messages.find((m) => m.kind === "shell" && m.id === id);
        const msg = shellMessage(id, sh, d.output, now);
        if (existing) Object.assign(existing, msg, { created: existing.created });
        else s.messages.push(msg);
        return [s.id];
      }
      case "session.execution.started":
        return setStatus(this, sid!, "busy");
      case "session.execution.succeeded":
        return setStatus(this, sid!, "idle", true);
      case "session.execution.interrupted": {
        const ids = setStatus(this, sid!, "idle", true);
        notice(this.get(sid!), "info", interruptText(d.reason), now);
        return ids;
      }
      case "session.execution.failed": {
        const ids = setStatus(this, sid!, "error", true);
        notice(this.get(sid!), "error", errorText(d), now);
        return ids;
      }
      case "session.retry.scheduled": {
        const s = this.get(sid!);
        s.retry = { attempt: Number(d.attempt ?? 1), at: Number(d.at ?? now), message: errorText(d) };
        return [s.id];
      }
      case "session.step.started": {
        const s = this.get(sid!);
        s.retry = undefined;
        const msg = assistant(s, d.assistantMessageID, now);
        msg.agent = d.agent ?? msg.agent;
        msg.model = d.model ?? msg.model;
        // Emitted with the first streamed chunk; `started` is when the request went out.
        msg.timing = { start: d.started ?? msg.created, firstToken: now };
        return [s.id];
      }
      case "session.step.streamed": {
        const s = this.get(sid!);
        const msg = assistant(s, d.assistantMessageID, now);
        if (msg.timing) msg.timing.end = now;
        return [s.id];
      }
      case "session.step.ended": {
        const s = this.get(sid!);
        const msg = assistant(s, d.assistantMessageID, now);
        msg.finish = d.finish;
        if (d.tokens) msg.tokens = toTokens(d.tokens);
        if (msg.timing) msg.timing.end ??= now;
        if (d.finish !== "tool-calls") msg.done = true;
        for (const b of msg.blocks) if (b.type !== "tool") b.done = true;
        return [s.id];
      }
      case "session.step.failed": {
        const s = this.get(sid!);
        // An interrupt fails the running step too; execution.interrupted says so once.
        if (d.error?.type === "aborted") return [];
        notice(s, "error", errorText(d), now);
        return [s.id];
      }
      case "session.reasoning.started":
      case "session.text.started": {
        const s = this.get(sid!);
        const kind = ev.type === "session.text.started" ? "text" : "reasoning";
        const b = streamBlock(assistant(s, d.assistantMessageID, now), kind, d.ordinal);
        if (b.type === "reasoning") b.started ??= now;
        return [s.id];
      }
      case "session.reasoning.delta":
      case "session.text.delta": {
        const s = this.get(sid!);
        const kind = ev.type === "session.text.delta" ? "text" : "reasoning";
        const b = streamBlock(assistant(s, d.assistantMessageID, now), kind, d.ordinal);
        b.text += d.delta ?? "";
        return [s.id];
      }
      case "session.reasoning.ended":
      case "session.text.ended": {
        const s = this.get(sid!);
        const kind = ev.type === "session.text.ended" ? "text" : "reasoning";
        const b = streamBlock(assistant(s, d.assistantMessageID, now), kind, d.ordinal);
        if (typeof d.text === "string") b.text = d.text;
        b.done = true;
        if (b.type === "reasoning") b.ended = now;
        return [s.id];
      }
      case "session.tool.input.started": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id, d.name);
        t.started ??= now;
        return [s.id];
      }
      case "session.tool.called": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id);
        t.status = "running";
        t.input = d.input ?? t.input;
        t.started ??= now;
        return [s.id];
      }
      case "session.tool.progress": {
        const s = this.get(sid!);
        const calls = toolCalls(d.metadata);
        if (!calls) return [];
        tool(assistant(s, d.assistantMessageID, now), d.id).calls = calls;
        return [s.id];
      }
      case "session.tool.success": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id);
        t.status = "completed";
        t.output = contentText(d.content);
        t.ended = now;
        t.calls = toolCalls(d.metadata) ?? t.calls;
        const child = d.metadata?.sessionID;
        if (typeof child === "string" && child !== s.id) t.childSessionID = child;
        trackEdit(s, t);
        // A worker edits the lead's tree: its changes belong in the lead's list too.
        return withParent(this, s, (p) => {
          for (const f of s.changedFiles) if (!p.changedFiles.includes(f)) p.changedFiles.push(f);
        });
      }
      case "session.tool.failed": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id);
        t.status = "error";
        t.error = errorText(d);
        t.ended = now;
        t.calls = toolCalls(d.metadata) ?? t.calls;
        return [s.id];
      }
      case "session.usage.updated": {
        const s = this.get(sid!);
        s.usage = toTokens(d.tokens);
        if (typeof d.cost === "number") s.cost = d.cost;
        return [s.id];
      }
      case "permission.asked": {
        const req = toPermission(d);
        if (!req) return [];
        const s = this.get(req.sessionID);
        s.permissions = s.permissions.filter((p) => p.id !== req.id).concat(req);
        return withParent(this, s);
      }
      case "permission.replied":
      case "permission.rejected": {
        const id = d.requestID ?? d.id ?? d.request?.id;
        const owner = d.sessionID ?? d.request?.sessionID;
        const changed: string[] = [];
        for (const s of owner ? [this.get(owner)] : this.sessions.values()) {
          const before = s.permissions.length;
          s.permissions = s.permissions.filter((p) => p.id !== id);
          if (s.permissions.length !== before) changed.push(...withParent(this, s));
        }
        return changed;
      }
      case "form.created": {
        const f = toForm(d);
        if (!f) return [];
        const s = this.get(f.sessionID);
        s.forms = s.forms.filter((x) => x.id !== f.id).concat(f);
        return withParent(this, s);
      }
      case "form.replied":
      case "form.cancelled": {
        const id = d.formID ?? d.id ?? d.form?.id;
        const changed: string[] = [];
        for (const s of this.sessions.values()) {
          const before = s.forms.length;
          s.forms = s.forms.filter((f) => f.id !== id);
          if (s.forms.length !== before) changed.push(s.id);
        }
        return changed;
      }
      default:
        return [];
    }
  }

  /**
   * Replaces a session's messages with server history (GET .../message,
   * newest first). Used on open and after a reconnect, since the event stream
   * does not replay what was missed.
   */
  loadHistory(info: any, items: any[]): SessionView {
    const s = this.get(info.id);
    s.title = info.title ?? s.title;
    s.agent = info.agent ?? s.agent;
    s.model = info.model ?? s.model;
    s.parentID = info.parentID ?? s.parentID;
    s.cost = typeof info.cost === "number" ? info.cost : s.cost;
    s.pinned = Boolean(info.metadata?.pinned);
    s.revert = info.revert?.messageID ? { messageID: info.revert.messageID, files: (info.revert.files ?? []).map((f: any) => String(f.file)) } : undefined;
    const messages: Message[] = [];
    for (const m of [...items].reverse()) {
      const created = m.time?.created ?? 0;
      if (m.type === "user") {
        messages.push(userMessage(m.id, { text: m.text ?? m.payload?.text ?? "", files: m.files }, created));
      } else if (m.type === "shell") {
        // Live events know the shell by its sh_ id only; use it here too.
        messages.push(shellMessage(String(m.shellID ?? m.id), m, m.output, created));
      } else if (m.type === "compaction") {
        messages.push({ kind: "compaction", id: m.id, status: m.status === "failed" ? "failed" : m.status === "running" ? "running" : "completed", reason: m.reason, summary: m.summary, created });
      } else if (m.type === "idle" && m.outcome === "interrupted") {
        messages.push({ kind: "notice", id: m.id, level: "info", text: interruptText(m.metadata?.reason), created });
      } else if (m.type === "assistant") {
        const blocks: Block[] = [];
        for (const c of m.content ?? []) {
          if (c.type === "reasoning") {
            blocks.push({ type: "reasoning", text: c.text ?? "", done: true, started: c.time?.created, ended: c.time?.completed });
          } else if (c.type === "text") {
            blocks.push({ type: "text", text: c.text ?? "", done: true });
          } else if (c.type === "tool") {
            const st = c.state ?? {};
            const t: ToolBlock = {
              type: "tool",
              id: c.id,
              name: c.name,
              status: st.status === "error" ? "error" : st.status === "completed" ? "completed" : "running",
              input: st.input,
              output: contentText(st.content),
              error: st.status === "error" ? errorText(st) : undefined,
              ...(toolCalls(st.metadata) ? { calls: toolCalls(st.metadata) } : {}),
            };
            const child = st.metadata?.sessionID;
            if (typeof child === "string") t.childSessionID = child;
            blocks.push(t);
            trackEdit(s, t);
          }
        }
        const firstToken = (m.content ?? []).find((c: any) => c.time?.created)?.time.created;
        messages.push({
          kind: "assistant",
          id: m.id,
          agent: m.agent,
          model: m.model,
          blocks,
          created,
          done: Boolean(m.time?.completed),
          finish: m.finish,
          ...(m.tokens ? { tokens: toTokens(m.tokens) } : {}),
          ...(firstToken ? { timing: { start: created, firstToken, end: m.time?.streamed ?? m.time?.completed } } : {}),
        });
      } else if (m.type === "synthetic" && m.metadata?.source === "subagent") {
        messages.push({ kind: "notice", id: m.id, level: "info", text: `Worker ${m.metadata.agent ?? ""} ${m.metadata.state ?? ""}: ${m.description ?? ""}`, created });
      }
    }
    s.messages = messages;
    return s;
  }

  /** Undelivered prompts from GET .../inbox, which history does not include. */
  loadInbox(id: string, items: any[]) {
    const s = this.get(id);
    s.pending = (items ?? [])
      .filter((i) => i?.type === "user" && i.delivery === "queue" && typeof i.payload?.text === "string")
      .map((i) => ({ id: String(i.id), text: i.payload.text, delivery: "queue" as const, created: i.time?.created ?? 0 }));
  }
}

function withParent(store: Store, s: SessionView, fn?: (p: SessionView) => void): string[] {
  if (!s.parentID) return [s.id];
  const p = store.get(s.parentID);
  fn?.(p);
  return [s.id, p.id];
}

function setStatus(store: Store, sid: string, status: SessionStatus, finish = false): string[] {
  const s = store.get(sid);
  s.status = status;
  if (finish) {
    s.retry = undefined;
    for (const m of s.messages) {
      if (m.kind !== "assistant" || m.done) continue;
      m.done = true;
      for (const b of m.blocks) {
        if (b.type === "tool") {
          if (b.status === "running" || b.status === "pending") b.status = status === "error" ? "error" : "completed";
        } else b.done = true;
      }
    }
  }
  return withParent(store, s, (p) => upsertChild(p, { id: s.id, status }));
}

function upsertChild(parent: SessionView, child: Partial<ChildSession> & { id: string }) {
  const existing = parent.children.find((c) => c.id === child.id);
  if (existing) Object.assign(existing, stripUndefined(child));
  else parent.children.push({ title: "Subagent", status: "busy", ...stripUndefined(child) } as ChildSession);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function assistant(s: SessionView, id: string, created: number): AssistantMessage {
  const found = s.messages.find((m): m is AssistantMessage => m.kind === "assistant" && m.id === id);
  if (found) return found;
  const msg: AssistantMessage = { kind: "assistant", id, blocks: [], created, done: false };
  s.messages.push(msg);
  s.status = "busy";
  return msg;
}

/**
 * Streamed blocks are addressed by (kind, ordinal) within a message. Order of
 * first appearance is kept, which is the order the model produced them.
 */
function streamBlock(msg: AssistantMessage, kind: "text" | "reasoning", ordinal = 0): TextBlock | ReasoningBlock {
  let seen = -1;
  for (const b of msg.blocks) {
    if (b.type !== kind) continue;
    seen++;
    if (seen === ordinal) return b as TextBlock | ReasoningBlock;
  }
  const b: TextBlock | ReasoningBlock = { type: kind, text: "", done: false };
  msg.blocks.push(b);
  return b;
}

function tool(msg: AssistantMessage, id: string, name?: string): ToolBlock {
  let t = msg.blocks.find((b): b is ToolBlock => b.type === "tool" && b.id === id);
  if (!t) {
    t = { type: "tool", id, name: name ?? "tool", status: "pending" };
    msg.blocks.push(t);
  } else if (name) t.name = name;
  return t;
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

function trackEdit(s: SessionView, t: ToolBlock) {
  if (!EDIT_TOOLS.has(t.name) || t.status !== "completed") return;
  const p = (t.input?.path ?? t.input?.filePath ?? t.input?.file_path) as string | undefined;
  if (typeof p === "string" && !s.changedFiles.includes(p)) s.changedFiles.push(p);
}

/** A user prompt, or the guard plugin note it really is. */
function userMessage(id: string, payload: { text: string; files?: any[] }, created: number): Message {
  if (guardNote(payload.text)) return { kind: "notice", id, level: "warn", text: payload.text.replace(/^\(Tellico(?: loop guard)?\)\s*/, ""), created };
  const files = (payload.files ?? []).map((f: any) => String(f?.name ?? f?.source?.uri ?? f?.uri ?? "")).filter(Boolean);
  return { kind: "user", id, text: payload.text, ...(files.length ? { files } : {}), created };
}

function shellMessage(id: string, sh: any, output: any, created: number): ShellMessage {
  const status = ["running", "exited", "timeout", "killed"].includes(sh?.status) ? sh.status : "running";
  const exit = typeof sh?.exit === "number" ? sh.exit : undefined;
  return { kind: "shell", id, command: String(sh?.command ?? ""), status, exit, output: typeof output?.output === "string" ? output.output : undefined, created };
}

function toolCalls(md: any): { tool: string; status: string }[] | undefined {
  const calls = md?.toolCalls;
  if (!Array.isArray(calls) || !calls.length) return undefined;
  return calls.map((c: any) => ({ tool: String(c?.tool ?? "tool"), status: String(c?.status ?? "running") }));
}

function interruptText(reason: unknown): string {
  switch (reason) {
    case "shutdown":
      return "Stopped: the server shut down.";
    case "superseded":
      return "Interrupted by a newer prompt.";
    case "inactivity":
      return "Stopped after a long stretch with no progress.";
    default:
      return "Interrupted.";
  }
}

function toTokens(t: any): StepTokens {
  return { input: t?.input ?? 0, output: t?.output ?? 0, reasoning: t?.reasoning ?? 0, cacheRead: t?.cache?.read ?? 0 };
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((c: any) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function errorText(d: any): string {
  const e = d?.error ?? d;
  if (typeof e === "string") return e;
  return e?.message ?? e?.data?.message ?? e?.name ?? "Unknown error";
}

function notice(s: SessionView, level: "info" | "error", text: string, created: number) {
  s.messages.push({ kind: "notice", id: `notice-${created}-${s.messages.length}`, level, text, created });
}

export function toPermission(d: any): PermissionRequest | undefined {
  const r = d?.request ?? d;
  if (!r || typeof r.id !== "string" || typeof r.sessionID !== "string") return undefined;
  return {
    id: r.id,
    sessionID: r.sessionID,
    action: String(r.action ?? "permission"),
    resources: Array.isArray(r.resources) ? r.resources.map(String) : [],
    title: typeof r.message === "string" ? r.message : undefined,
  };
}

export function toForm(d: any): FormQuestion | undefined {
  const f = d?.form ?? d?.info ?? d;
  if (!f || typeof f.id !== "string" || typeof f.sessionID !== "string") return undefined;
  return { id: f.id, sessionID: f.sessionID, title: f.title ?? f.metadata?.title ?? "Question", raw: f };
}

export type { ModelRef };
