// Turns OpenCode 2 server events and history into SessionView objects.
// Pure functions only: no vscode import, so the whole thing is unit-testable
// against recorded event streams (test/fixtures).

import {
  AssistantMessage,
  Block,
  ChildSession,
  emptySession,
  FormQuestion,
  Message,
  ModelRef,
  PermissionRequest,
  ReasoningBlock,
  SessionStatus,
  TextBlock,
  SessionView,
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
      case "session.inbox.enqueued": {
        const s = this.get(sid!);
        const item = d.item ?? {};
        if (item.type === "user" && typeof item.payload?.text === "string") {
          // The prompt call already added an optimistic copy; replace it.
          const id = d.inboxID as string;
          s.messages = s.messages.filter((m) => !(m.kind === "user" && m.id === id));
          s.messages.push({ kind: "user", id, text: item.payload.text, created: now });
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
      case "session.execution.started":
        return setStatus(this, sid!, "busy");
      case "session.execution.succeeded":
      case "session.idle":
        return setStatus(this, sid!, "idle", true);
      case "session.execution.interrupted": {
        const ids = setStatus(this, sid!, "idle", true);
        notice(this.get(sid!), "info", "Interrupted.", now);
        return ids;
      }
      case "session.execution.failed":
      case "session.error": {
        const ids = setStatus(this, sid!, "error", true);
        notice(this.get(sid!), "error", errorText(d), now);
        return ids;
      }
      case "session.retry.scheduled": {
        notice(this.get(sid!), "info", `Retrying: ${errorText(d)}`, now);
        return [sid!];
      }
      case "session.step.started": {
        const s = this.get(sid!);
        const msg = assistant(s, d.assistantMessageID, now);
        msg.agent = d.agent ?? msg.agent;
        msg.model = d.model ?? msg.model;
        return [s.id];
      }
      case "session.step.ended": {
        const s = this.get(sid!);
        const msg = assistant(s, d.assistantMessageID, now);
        msg.finish = d.finish;
        if (d.finish !== "tool-calls") msg.done = true;
        for (const b of msg.blocks) if (b.type !== "tool") b.done = true;
        return [s.id];
      }
      case "session.step.failed": {
        const s = this.get(sid!);
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
        tool(assistant(s, d.assistantMessageID, now), d.id, d.name);
        return [s.id];
      }
      case "session.tool.called": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id);
        t.status = "running";
        t.input = d.input ?? t.input;
        return [s.id];
      }
      case "session.tool.success": {
        const s = this.get(sid!);
        const t = tool(assistant(s, d.assistantMessageID, now), d.id);
        t.status = "completed";
        t.output = contentText(d.content);
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
        return [s.id];
      }
      case "session.usage.updated": {
        const s = this.get(sid!);
        const t = d.tokens ?? {};
        s.usage = { input: t.input ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0, cacheRead: t.cache?.read ?? 0 };
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
    const messages: Message[] = [];
    for (const m of [...items].reverse()) {
      const created = m.time?.created ?? 0;
      if (m.type === "user") {
        messages.push({ kind: "user", id: m.id, text: m.text ?? m.payload?.text ?? "", created });
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
            };
            const child = st.metadata?.sessionID;
            if (typeof child === "string") t.childSessionID = child;
            blocks.push(t);
            trackEdit(s, t);
          }
        }
        messages.push({
          kind: "assistant",
          id: m.id,
          agent: m.agent,
          model: m.model,
          blocks,
          created,
          done: Boolean(m.time?.completed),
          finish: m.finish,
        });
      } else if (m.type === "synthetic" && m.metadata?.source === "subagent") {
        messages.push({ kind: "notice", id: m.id, level: "info", text: `Worker ${m.metadata.agent ?? ""} ${m.metadata.state ?? ""}: ${m.description ?? ""}`, created });
      }
    }
    s.messages = messages;
    return s;
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
