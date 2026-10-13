import "./style.css";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import type { AssistantMessage, ChildSession, FormQuestion, Message, PermissionRequest, ReasoningBlock, ThinkLevel, ToolBlock } from "../shared/model";
import { stripMarkers, THINK_LEVELS } from "../shared/model";
import { advance, hidePartialMarker, safeCut } from "./smooth";
import type { EditorContext, HostToWebview, Prefs, ServerStatus, SessionMeta, SessionSummary, WebviewToHost } from "../shared/protocol";
import { SessionStats, sessionStats, TurnSummary, turnSummary } from "../shared/stats";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

// ---------------- state ----------------

interface State {
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

const initial: State = { server: { kind: "starting" }, commands: [], context: {}, messages: [], showHistory: 0 };

function reduce(state: State, batch: HostToWebview[]): State {
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
function useHostState(): State {
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

/** Re-renders every `ms` while `active`, for elapsed-time labels. */
function useTicker(active: boolean, ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

// ---------------- smooth streaming ----------------

const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** Set from prefs; read by every paced block. */
let smoothEnabled = true;

/**
 * Text revealed at a steady pace while `live`. A block that is complete when
 * it mounts (history, a reopened session) shows at once. One animation-frame
 * loop per streaming block, and only while it has a backlog to show.
 */
function useSmoothText(text: string, live: boolean): string {
  const [shown, setShown] = useState(() => (live && smoothEnabled && !reducedMotion ? 0 : text.length));
  const pos = useRef(shown);
  const target = useRef(text.length);
  const done = useRef(!live);
  const frame = useRef(0);
  target.current = text.length;
  done.current = !live;

  useEffect(() => {
    if (!smoothEnabled || reducedMotion) {
      pos.current = text.length;
      setShown(text.length);
      return;
    }
    if (frame.current || pos.current >= target.current) return;
    let last = performance.now();
    const tick = (now: number) => {
      // Cap dt so a hidden tab does not dump its whole backlog in one frame.
      const dt = Math.min(64, now - last);
      last = now;
      pos.current = advance(pos.current, target.current, dt, done.current);
      const n = Math.floor(pos.current);
      setShown((prev) => (prev === n ? prev : n));
      frame.current = pos.current < target.current ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [text, live]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return text.slice(0, safeCut(text, shown));
}

/** A streaming markdown block; the paced prefix is what gets parsed. */
function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text, live);
  if (!shown.trim()) return null;
  return <Markdown text={shown} />;
}

// ---------------- icons ----------------

const Icon = ({ name, className = "" }: { name: string; className?: string }) => <i className={`codicon codicon-${name} ${className}`} aria-hidden />;

/** A "T" whose crossbar joins the two Tellico nodes. */
function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id="tg" gradientUnits="userSpaceOnUse" x1="2" y1="3" x2="22" y2="21">
          <stop offset="0" stopColor="var(--tc-accent)" />
          <stop offset="1" stopColor="var(--tc-accent-2)" />
        </linearGradient>
      </defs>
      <g stroke="url(#tg)">
        <path d="M7.2 6.5h9.6" />
        <path d="M12 6.5v8.2" />
        <circle cx="4.8" cy="6.5" r="2.2" />
        <circle cx="19.2" cy="6.5" r="2.2" />
        <circle cx="12" cy="18" r="2.6" />
      </g>
    </svg>
  );
}

// ---------------- markdown ----------------

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const language = (lang ?? "").split(/\s/)[0];
  let body: string;
  try {
    body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text);
  } catch {
    body = escapeHtml(text);
  }
  return (
    `<div class="codeblock"><div class="codeblock-head"><span>${escapeHtml(language || "text")}</span>` +
    `<button class="copy" data-copy="${encodeURIComponent(text)}" title="Copy"><i class="codicon codicon-copy"></i></button></div>` +
    `<pre><code class="hljs">${body}</code></pre></div>`
  );
};
const md = new Marked({ gfm: true, breaks: false, renderer });

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.parse(text, { async: false }) as string, { ADD_ATTR: ["data-copy"] }), [text]);
  const onClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLElement>("[data-copy]");
    if (copy) {
      post({ type: "copy", text: decodeURIComponent(copy.dataset.copy ?? "") });
      copy.classList.add("copied");
      setTimeout(() => copy.classList.remove("copied"), 1200);
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:/.test(href)) {
      e.preventDefault();
      const m = /^(.*?)(?::(\d+)|#L(\d+))?$/.exec(href);
      if (m && m[1]) post({ type: "openFile", path: m[1], line: Number(m[2] ?? m[3]) || undefined });
    }
  }, []);
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

// ---------------- tool rows ----------------

const rel = (p: string, root?: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.replace(/\n$/, "").split("\n").length : 0);

interface ToolView {
  icon: string;
  verb: string;
  target?: string;
  mono?: boolean;
  path?: string;
  adds?: number;
  dels?: number;
}

function describeTool(t: ToolBlock, root?: string): ToolView {
  const i = (t.input ?? {}) as Record<string, any>;
  const path = (i.path ?? i.filePath) as string | undefined;
  const p = path ? rel(path, root) : undefined;
  switch (t.name) {
    case "read":
      return { icon: "file", verb: "Read", target: p, path };
    case "edit":
    case "multiedit":
      return { icon: "edit", verb: "Edit", target: p, path, adds: lineCount(i.newString), dels: lineCount(i.oldString) };
    case "write":
      return { icon: "new-file", verb: "Write", target: p, path, adds: lineCount(i.content) };
    case "patch":
    case "apply_patch":
      return { icon: "diff", verb: "Patch", target: p, path };
    case "shell":
    case "bash":
      return { icon: "terminal", verb: "Run", target: String(i.command ?? ""), mono: true };
    case "grep":
      return { icon: "search", verb: "Search", target: `${i.pattern ?? ""}${i.include ? `  in ${i.include}` : ""}`, mono: true };
    case "glob":
      return { icon: "files", verb: "Find", target: String(i.pattern ?? ""), mono: true };
    case "list":
      return { icon: "list-tree", verb: "List", target: p ?? "." };
    case "webfetch":
      return { icon: "globe", verb: "Fetch", target: String(i.url ?? "") };
    case "websearch":
      return { icon: "search-fuzzy", verb: "Web search", target: String(i.query ?? "") };
    case "subagent":
    case "task": {
      const agent = String(i.agent ?? i.subagent_type ?? "worker").replace(/^tellico-/, "");
      return { icon: "organization", verb: "Delegate", target: `${agent}${i.description ? ` — ${i.description}` : ""}` };
    }
    case "todowrite":
      return { icon: "checklist", verb: "Update plan" };
    default:
      if (t.name.startsWith("ctx_")) return { icon: "layers", verb: "Context", target: t.name.slice(4).replace(/_/g, " ") };
      return { icon: "tools", verb: t.name, target: p ?? (i.query || i.pattern || undefined) };
  }
}

const ToolRow = memo(function ToolRow({ t, root }: { t: ToolBlock; root?: string }) {
  const [open, setOpen] = useState(false);
  const v = describeTool(t, root);
  const i = (t.input ?? {}) as Record<string, any>;
  const body = t.status === "error" ? t.error : t.output;
  const editPreview = (t.name === "edit" || t.name === "multiedit") && (i.oldString || i.newString);
  const expandable = Boolean(body || editPreview || (v.mono && v.target));
  return (
    <div className={`step step-${t.status}`}>
      <div className={`step-head ${expandable ? "expandable" : ""}`} onClick={() => expandable && setOpen(!open)}>
        <span className="step-verb">{v.verb}</span>
        {v.target && <span className={`step-target ${v.mono ? "mono" : ""}`} title={v.target}>{v.target}</span>}
        {(v.adds || v.dels) && t.status === "completed" ? (
          <span className="stat">
            {v.adds ? <span className="add">+{v.adds}</span> : null}
            {v.dels ? <span className="del">−{v.dels}</span> : null}
          </span>
        ) : null}
        <span className="step-actions">
          {v.path && EDIT_TOOLS.has(t.name) && t.status === "completed" && (
            <button className="ghost" title="Show diff" onClick={(e) => (e.stopPropagation(), post({ type: "openDiff", path: v.path! }))}><Icon name="diff" /></button>
          )}
          {v.path && (
            <button className="ghost" title="Open file" onClick={(e) => (e.stopPropagation(), post({ type: "openFile", path: v.path! }))}><Icon name="go-to-file" /></button>
          )}
        </span>
        {t.childSessionID && (
          <button className="ghost label" onClick={(e) => (e.stopPropagation(), post({ type: "openSession", id: t.childSessionID!, inNewTab: true }))}>
            Open <Icon name="link-external" />
          </button>
        )}
        {expandable && <Icon name="chevron-right" className={`step-chevron ${open ? "open" : ""}`} />}
      </div>
      {open && (
        <div className="step-body">
          {editPreview ? (
            <pre className="diff">
              {i.oldString ? String(i.oldString).replace(/\n$/, "").split("\n").map((l, n) => <div key={`o${n}`} className="del">{l || " "}</div>) : null}
              {i.newString ? String(i.newString).replace(/\n$/, "").split("\n").map((l, n) => <div key={`n${n}`} className="add">{l || " "}</div>) : null}
            </pre>
          ) : (
            <pre>
              {v.verb === "Run" ? <span className="prompt">$ {v.target}{body ? "\n" : ""}</span> : null}
              {body ? (body.length > 20000 ? body.slice(0, 20000) + "\n…" : body) : null}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

const Reasoning = memo(function Reasoning({ b, defaultOpen }: { b: ReasoningBlock; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useTicker(!b.done);
  if (!b.text.trim() && b.done) return null;
  const secs = b.started ? Math.max(1, Math.round(((b.ended ?? Date.now()) - b.started) / 1000)) : undefined;
  return (
    <div className={`thought ${open ? "open" : ""}`}>
      <div className="thought-head" onClick={() => setOpen(!open)}>
        {b.done ? <span>Thought{secs ? ` for ${secs}s` : ""}</span> : <span className="shimmer">Thinking{secs ? ` · ${secs}s` : "…"}</span>}
        <Icon name="chevron-right" className="thought-chevron" />
      </div>
      {open && <ThoughtBody text={b.text} live={!b.done} />}
    </div>
  );
});

function ThoughtBody({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text, live);
  return <div className="thought-body">{shown.trim()}</div>;
}

/** Consecutive tool calls render as one timeline group, like a run of steps. */
const AssistantView = memo(function AssistantView({ m, showReasoning, root }: { m: AssistantMessage; showReasoning: boolean; root?: string }) {
  const groups: React.ReactNode[] = [];
  let steps: ToolBlock[] = [];
  const flush = (key: string) => {
    if (!steps.length) return;
    const run = steps;
    steps = [];
    groups.push(
      <div className={`steps ${run.length === 1 ? "single" : ""}`} key={key}>
        {run.map((t) => <ToolRow key={t.id} t={t} root={root} />)}
      </div>,
    );
  };
  m.blocks.forEach((b, i) => {
    if (b.type === "tool") {
      steps.push(b);
      return;
    }
    flush(`s${i}`);
    if (b.type === "text") {
      const text = hidePartialMarker(stripMarkers(b.text));
      if (text.trim() || !b.done) groups.push(<LiveMarkdown key={i} text={text} live={!b.done && !m.done} />);
    } else groups.push(<Reasoning key={i} b={b} defaultOpen={showReasoning} />);
  });
  flush("end");
  return <div className="assistant">{groups}</div>;
});

// ---------------- transcript ----------------

function Working({ since }: { since: number }) {
  useTicker(true);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <div className="working">
      <span className="dots"><i /><i /><i /></span>
      <span className="shimmer">Working</span>
      <span className="muted tabular">{secs}s · esc to stop</span>
    </div>
  );
}

/** Under the last step of a finished turn: how much it generated and how fast. */
function TurnFooter({ t }: { t: TurnSummary }) {
  return (
    <div className="turn-foot tabular">
      <span>{t.steps} step{t.steps === 1 ? "" : "s"}</span>
      {t.output > 0 && <span>{fmt(t.output)} tokens</span>}
      <span>{fmtDuration(t.elapsed)}</span>
      {t.decode !== undefined && <span title="Generated tokens per second, averaged over the turn's steps">{t.decode.toFixed(1)} tok/s</span>}
    </div>
  );
}

/** Turn summaries keyed by the id of each finished turn's last assistant message. */
function turnFooters(messages: Message[], busy: boolean): Map<string, TurnSummary> {
  const out = new Map<string, TurnSummary>();
  let steps: AssistantMessage[] = [];
  const close = () => {
    const t = steps.length ? turnSummary(steps) : undefined;
    if (t) out.set(steps[steps.length - 1].id, t);
    steps = [];
  };
  for (const m of messages) {
    if (m.kind === "user") close();
    else if (m.kind === "assistant") steps.push(m);
  }
  if (!busy) close();
  return out;
}

function Transcript({ messages, showReasoning, root, busy }: { messages: Message[]; showReasoning: boolean; root?: string; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busySince = useRef(0);
  if (busy && !busySince.current) busySince.current = Date.now();
  if (!busy) busySince.current = 0;
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Paced text grows inside its own component, without re-rendering this one,
  // so follow the content's height rather than our own renders.
  useEffect(() => {
    const el = ref.current;
    const body = inner.current;
    if (!el || !body || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const footers = useMemo(() => turnFooters(messages, busy), [messages, busy]);
  const last = messages[messages.length - 1];
  const streaming = Boolean(last && last.kind === "assistant" && !last.done && last.blocks.some((b) => b.type !== "tool" && !b.done));
  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="transcript-inner" ref={inner}>
        {messages.map((m) =>
          m.kind === "user" ? (
            <div key={m.id} className="user">
              <div className="user-bubble">{m.text}</div>
            </div>
          ) : m.kind === "assistant" ? (
            <React.Fragment key={m.id}>
              <AssistantView m={m} showReasoning={showReasoning} root={root} />
              {footers.has(m.id) && <TurnFooter t={footers.get(m.id)!} />}
            </React.Fragment>
          ) : (
            <div key={m.id} className={`event event-${m.level}`}>
              <Icon name={m.level === "error" ? "warning" : m.text.startsWith("Worker") ? "pass" : "info"} />
              <span>{m.text}</span>
            </div>
          ),
        )}
        {busy && !streaming && <Working since={busySince.current} />}
      </div>
    </div>
  );
}

// ---------------- tray: workers + changes ----------------

function Stat({ add, del }: { add: number; del: number }) {
  if (!add && !del) return null;
  return (
    <span className="stat">
      {add ? <span className="add">+{add}</span> : null}
      {del ? <span className="del">−{del}</span> : null}
    </span>
  );
}

function Tray({ children, files, stats, root }: { children: ChildSession[]; files: string[]; stats?: SessionMeta["fileStats"]; root?: string }) {
  const [open, setOpen] = useState<"workers" | "files" | null>(null);
  const running = children.filter((c) => c.status === "busy").length;
  const totals = files.reduce((a, f) => ({ add: a.add + (stats?.[f]?.additions ?? 0), del: a.del + (stats?.[f]?.deletions ?? 0) }), { add: 0, del: 0 });
  if (!children.length && !files.length) return null;
  return (
    <div className="tray">
      {open === "workers" && (
        <div className="tray-list">
          {children.map((c) => (
            <div key={c.id} className="tray-row clickable" onClick={() => post({ type: "openSession", id: c.id, inNewTab: true })}>
              {c.status === "busy" ? <span className="spin" /> : <Icon name={c.status === "error" ? "error" : "pass-filled"} className={`st-${c.status}`} />}
              <span className="grow ellipsis">{c.title}</span>
              {c.agent && <span className="badge">{c.agent.replace("tellico-", "")}</span>}
              <Icon name="link-external" className="dim" />
            </div>
          ))}
        </div>
      )}
      {open === "files" && (
        <div className="tray-list">
          {files.map((f) => (
            <div key={f} className="tray-row">
              <span className="grow ellipsis clickable mono-sm" title={f} onClick={() => post({ type: "openDiff", path: f })}>{rel(f, root)}</span>
              {stats?.[f] && <Stat add={stats[f].additions} del={stats[f].deletions} />}
              <button className="ghost" title="Show diff" onClick={() => post({ type: "openDiff", path: f })}><Icon name="diff" /></button>
              <button className="ghost" title="Revert this file" onClick={() => post({ type: "revertFile", path: f })}><Icon name="discard" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="tray-bar">
        {children.length > 0 && (
          <button className={`tray-tab ${open === "workers" ? "on" : ""}`} onClick={() => setOpen(open === "workers" ? null : "workers")}>
            {running ? <span className="spin" /> : <Icon name="organization" />}
            {running ? `${running} worker${running > 1 ? "s" : ""} running` : `${children.length} worker${children.length > 1 ? "s" : ""}`}
            <Icon name={open === "workers" ? "chevron-down" : "chevron-up"} className="dim" />
          </button>
        )}
        {files.length > 0 && (
          <button className={`tray-tab ${open === "files" ? "on" : ""}`} onClick={() => setOpen(open === "files" ? null : "files")}>
            <Icon name="diff-multiple" />
            {files.length} file{files.length > 1 ? "s" : ""}
            <Stat add={totals.add} del={totals.del} />
            <Icon name={open === "files" ? "chevron-down" : "chevron-up"} className="dim" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- permission + question cards ----------------

function Permissions({ items }: { items: PermissionRequest[] }) {
  return (
    <>
      {items.map((p) => (
        <div key={p.id} className="card">
          <div className="card-title"><Icon name="shield" /> Allow {p.action.replace(/_/g, " ")}?</div>
          {p.title && <div className="card-text">{p.title}</div>}
          {p.resources.length > 0 && <pre className="resource">{p.resources.join("\n")}</pre>}
          <div className="choices">
            <button className="choice primary" onClick={() => post({ type: "permission", sessionID: p.sessionID, requestID: p.id, decision: "once" })}><span className="num">1</span> Allow once</button>
            <button className="choice" onClick={() => post({ type: "permission", sessionID: p.sessionID, requestID: p.id, decision: "always" })}><span className="num">2</span> Always allow</button>
            <button className="choice" onClick={() => post({ type: "permission", sessionID: p.sessionID, requestID: p.id, decision: "reject" })}><span className="num">3</span> Deny</button>
          </div>
        </div>
      ))}
    </>
  );
}

function FormCard({ f }: { f: FormQuestion }) {
  const fields: any[] = Object.entries(((f.raw as any)?.fields ?? {}) as Record<string, any>).map(([key, v]) => ({ key, ...v }));
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <div className="card">
      <div className="card-title"><Icon name="comment-discussion" /> {f.title}</div>
      {fields.length === 0 && <div className="card-text">This question can't be shown here; dismiss it or answer in the terminal UI.</div>}
      {fields.map((fd) => (
        <label key={fd.key} className="field">
          <span>{fd.title ?? fd.label ?? fd.key}</span>
          {Array.isArray(fd.options) ? (
            <div className="choices">
              {fd.options.map((o: any) => {
                const value = String(o.value ?? o);
                return (
                  <button key={value} className={`choice ${values[fd.key] === value ? "primary" : ""}`} onClick={(e) => (e.preventDefault(), setValues({ ...values, [fd.key]: value }))}>
                    {String(o.label ?? o.value ?? o)}
                  </button>
                );
              })}
            </div>
          ) : fd.type === "boolean" ? (
            <input type="checkbox" onChange={(e) => setValues({ ...values, [fd.key]: e.target.checked })} />
          ) : (
            <input className="text" type="text" onChange={(e) => setValues({ ...values, [fd.key]: fd.type === "number" || fd.type === "integer" ? Number(e.target.value) : e.target.value })} />
          )}
        </label>
      ))}
      <div className="card-actions">
        {fields.length > 0 && <button className="btn primary" onClick={() => post({ type: "formReply", sessionID: f.sessionID, formID: f.id, answer: values })}>Submit</button>}
        <button className="btn" onClick={() => post({ type: "formCancel", sessionID: f.sessionID, formID: f.id })}>Dismiss</button>
      </div>
    </div>
  );
}

// ---------------- composer ----------------

interface MenuItem<T> {
  value: T;
  label: string;
  detail?: string;
}

/** A footer button that opens a small menu above it, in place of a native <select>. */
function MenuButton<T extends string | number>(props: {
  icon: string;
  label?: string;
  title: string;
  value: T;
  items: MenuItem<T>[];
  onPick(v: T): void;
  footer?: { label: string; icon: string; onClick(): void };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      <button className={`foot-btn ${open ? "on" : ""}`} title={props.title} onClick={() => setOpen(!open)}>
        <Icon name={props.icon} />
        {props.label && <span>{props.label}</span>}
      </button>
      {open && (
        <div className="menu">
          <div className="menu-title">{props.title}</div>
          {props.items.map((it) => (
            <div key={String(it.value)} className={`menu-item ${it.value === props.value ? "on" : ""}`} onClick={() => (props.onPick(it.value), setOpen(false))}>
              <div className="grow">
                <div>{it.label}</div>
                {it.detail && <div className="menu-detail">{it.detail}</div>}
              </div>
              {it.value === props.value && <Icon name="check" />}
            </div>
          ))}
          {props.footer && (
            <div className="menu-item menu-footer" onClick={() => (props.footer!.onClick(), setOpen(false))}>
              <Icon name={props.footer.icon} />
              <span>{props.footer.label}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const THINK_DETAIL: Record<ThinkLevel, string> = {
  off: "No reasoning, fastest",
  low: "Brief reasoning",
  medium: "Balanced, the default",
  xhigh: "The most the template allows",
};

function Composer(props: { state: State; busy: boolean; readOnly: boolean }) {
  const { state, busy, readOnly } = props;
  const prefs = state.prefs;
  const [text, setText] = useState<string>(() => vscode.getState()?.draft ?? "");
  const [attach, setAttach] = useState(true);
  const [sel, setSel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    vscode.setState({ ...(vscode.getState() ?? {}), draft: text });
  }, [text]);
  useEffect(() => {
    if (!state.insert) return;
    setText((t) => (t && !t.endsWith(" ") ? t + " " : t) + state.insert!.text);
    area.current?.focus();
  }, [state.insert?.n]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  const slash = /^\/(\S*)$/.exec(text);
  const allCommands = useMemo(
    () => [...THINK_LEVELS.map((l) => ({ name: `think-${l}`, description: `Thinking: ${THINK_DETAIL[l].toLowerCase()}` })), ...state.commands],
    [state.commands],
  );
  const matches = slash ? allCommands.filter((c) => c.name.startsWith(slash[1])).slice(0, 10) : [];
  useEffect(() => setSel(0), [slash?.[1]]);

  const send = () => {
    if (!text.trim() || readOnly) return;
    post({ type: "send", text, attachContext: attach });
    setText("");
  };

  if (readOnly)
    return (
      <div className="composer-wrap">
        <div className="readonly-note"><Icon name="eye" /> Worker transcript. Its report goes to the lead.</div>
      </div>
    );

  const ctx = state.context;
  const ctxLabel = ctx.file ? `${ctx.file.split("/").pop()}${ctx.selection ? `:${ctx.selection.start}-${ctx.selection.end}` : ""}` : undefined;

  return (
    <div className="composer-wrap">
      {matches.length > 0 && (
        <div className="menu slash-menu">
          {matches.map((c, n) => (
            <div key={c.name} className={`menu-item ${n === sel ? "on" : ""}`} onMouseEnter={() => setSel(n)} onMouseDown={(e) => (e.preventDefault(), setText(`/${c.name} `))}>
              <span className="cmd">/{c.name}</span>
              <span className="menu-detail grow ellipsis">{c.description}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer" onClick={() => area.current?.focus()}>
        {prefs?.attachActiveEditor && ctxLabel && (
          <div className="chips">
            <button className={`chip ${attach ? "" : "off"}`} onClick={(e) => (e.stopPropagation(), setAttach(!attach))} title={attach ? `${ctx.file} is attached. Click to leave it out.` : "Not attached. Click to attach."}>
              <Icon name={attach ? "file-code" : "eye-closed"} />
              <span>{ctxLabel}</span>
            </button>
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={busy ? "Queue a follow-up…" : "Ask Tellico to build, fix or explain…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSel((n) => (n + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing && matches.length) {
              e.preventDefault();
              setText(`/${matches[sel].name} `);
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && busy) {
              post({ type: "interrupt" });
            }
          }}
        />
        <div className="composer-foot" onClick={(e) => e.stopPropagation()}>
          {prefs && (
            <>
              <MenuButton
                icon={prefs.mode === "build" ? "tools" : "organization"}
                label={prefs.mode === "build" ? "Build" : "Orchestrate"}
                title="Agent"
                value={prefs.mode}
                items={[
                  { value: "build", label: "Build", detail: "One engineer does the whole job on one server" },
                  { value: "orchestrate", label: "Orchestrate", detail: "May delegate independent work to the two workers" },
                ]}
                onPick={(mode) => post({ type: "setPrefs", prefs: { mode } })}
              />
              <span className="divider" />
              <MenuButton
                icon="server"
                label={String(prefs.node)}
                title="Lead node"
                value={prefs.node}
                items={[
                  { value: 0, label: "Node 0", detail: "tellico-compute0" },
                  { value: 1, label: "Node 1", detail: "tellico-compute1" },
                ]}
                onPick={(node) => post({ type: "setPrefs", prefs: { node } })}
              />
              <span className="divider" />
              <MenuButton
                icon="lightbulb"
                label={prefs.think[0].toUpperCase() + prefs.think.slice(1)}
                title="Thinking"
                value={prefs.think}
                items={THINK_LEVELS.map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1), detail: THINK_DETAIL[l] }))}
                onPick={(think) => post({ type: "setPrefs", prefs: { think } })}
              />
              <span className="divider" />
              <MenuButton
                icon={prefs.connection === "gateway" ? "cloud" : "remote"}
                title={`Connection: ${prefs.connection === "gateway" ? "API gateway" : "SSH tunnel"}`}
                value={prefs.connectionSetting ?? "installed"}
                items={[
                  { value: "tunnel", label: "SSH tunnel", detail: "Your cluster account, over SSH" },
                  { value: "gateway", label: "API gateway", detail: "Per-user API key, no SSH" },
                  { value: "installed", label: "As installed", detail: "Whatever ./install.sh set up" },
                ]}
                onPick={(connectionSetting) => post({ type: "setPrefs", prefs: { connectionSetting } })}
                footer={{ label: "Set gateway API key…", icon: "key", onClick: () => post({ type: "setGatewayKey" }) }}
              />
            </>
          )}
          <span className="grow" />
          {busy ? (
            <button className="send stop" onClick={() => post({ type: "interrupt" })} title="Stop (Esc)"><Icon name="debug-stop" /></button>
          ) : (
            <button className="send" onClick={send} disabled={!text.trim()} title="Send (Enter)"><Icon name="arrow-up" /></button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- app ----------------

function ServerBanner({ server }: { server: ServerStatus }) {
  if (server.kind === "ready") return null;
  if (server.kind === "failed")
    return (
      <div className="banner error">
        <div className="banner-text"><Icon name="error" /> <span>{server.message}</span></div>
        <div className="card-actions">
          <button className="btn primary" onClick={() => post({ type: "restartServer" })}>Retry</button>
          <button className="btn" onClick={() => post({ type: "showLogs" })}>Show logs</button>
        </div>
      </div>
    );
  return (
    <div className="banner">
      <span className="spin" /> <span className="shimmer">Connecting to Tellico…</span>
    </div>
  );
}

const SUGGESTIONS = [
  { icon: "book", text: "Explain how this file works" },
  { icon: "bug", text: "Find and fix the bug in this file" },
  { icon: "beaker", text: "Write tests for this file and run them" },
  { icon: "git-pull-request", text: "Review my uncommitted changes" },
];

function Empty({ ready, sessions, onBrowse }: { ready: boolean; sessions?: SessionSummary[]; onBrowse(): void }) {
  useEffect(() => {
    if (ready) post({ type: "listSessions" });
  }, [ready]);
  const recent = (sessions ?? []).slice(0, 4);
  return (
    <div className="empty">
      <div className="hero">
        <Logo size={46} />
        <h1>Tellico</h1>
        <p>Qwen3.8 on two cluster nodes, with your agents, workers and plugins.</p>
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.text} className="suggestion" disabled={!ready} onClick={() => post({ type: "send", text: s.text, attachContext: true })}>
            <Icon name={s.icon} />
            <span>{s.text}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-head">
            <span>Recent</span>
            <button className="link" onClick={onBrowse}>View all</button>
          </div>
          {recent.map((x) => (
            <SessionRow key={x.id} s={x} compact />
          ))}
        </div>
      )}
      <div className="hints">
        <span><kbd>/</kbd> commands</span>
        <span><kbd>Alt</kbd>+<kbd>K</kbd> reference selection</span>
        {!recent.length && <button className="link" onClick={onBrowse}><Icon name="history" /> Resume a session</button>}
      </div>
    </div>
  );
}

// ---------------- session browser ----------------

const modeOf = (agent?: string) => /^(build|orchestrate)-tellico-([01])$/.exec(agent ?? "");

function SessionRow({ s, current, active, compact, onOpen }: { s: SessionSummary; current?: boolean; active?: boolean; compact?: boolean; onOpen?(): void }) {
  const m = modeOf(s.agent);
  const open = () => (post({ type: "openSession", id: s.id }), onOpen?.());
  return (
    <div className={`session-row ${current ? "current" : ""} ${active ? "active" : ""}`} onClick={open} title={s.title}>
      <Icon name={m?.[1] === "orchestrate" ? "organization" : "tools"} className="session-icon" />
      <div className="grow">
        <div className="ellipsis">{s.title}</div>
        {!compact && (
          <div className="session-meta">
            {m ? `${m[1] === "build" ? "Build" : "Orchestrate"} · node ${m[2]}` : s.agent ?? "session"} · started {new Date(s.created || s.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </div>
        )}
      </div>
      {current && <span className="badge">open</span>}
      <span className="session-time tabular">{relTime(s.updated)}</span>
      {!compact && (
        <span className="session-actions">
          <button className="ghost" title="Open in new tab" onClick={(e) => (e.stopPropagation(), post({ type: "openSession", id: s.id, inNewTab: true }), onOpen?.())}><Icon name="link-external" /></button>
          <button className="ghost" title="Delete session" onClick={(e) => (e.stopPropagation(), post({ type: "deleteSession", id: s.id }))}><Icon name="trash" /></button>
        </span>
      )}
    </div>
  );
}

const DAY = 86_400_000;

function groupLabel(t: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Previous 7 days";
  if (t >= today - 30 * DAY) return "Previous 30 days";
  return "Older";
}

function HistoryPanel({ sessions, currentId, onClose }: { sessions?: SessionSummary[]; currentId?: string; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | "build" | "orchestrate">("all");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    post({ type: "listSessions" });
  }, []);
  const q = query.trim().toLowerCase();
  const list = (sessions ?? []).filter((x) => (mode === "all" || modeOf(x.agent)?.[1] === mode) && (!q || x.title.toLowerCase().includes(q)));
  useEffect(() => {
    setSel(0);
  }, [q, mode]);
  const now = Date.now();
  let lastGroup = "";
  return (
    <div className="panel" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="panel-head">
        <Icon name="history" />
        <span className="grow">Sessions</span>
        <button className="ghost" title="New session" onClick={() => (post({ type: "newSession" }), onClose())}><Icon name="add" /></button>
        <button className="ghost" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="panel-tools">
        <div className="search">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (list.length) setSel((n) => (n + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
              } else if (e.key === "Enter" && list[sel]) {
                post({ type: "openSession", id: list[sel].id, inNewTab: e.ctrlKey || e.metaKey });
                onClose();
              }
            }}
          />
        </div>
        <div className="segmented">
          {(["all", "build", "orchestrate"] as const).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m === "all" ? "All" : m === "build" ? "Build" : "Orchestrate"}</button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {!sessions ? (
          <div className="panel-empty"><span className="spin" /> Loading…</div>
        ) : !list.length ? (
          <div className="panel-empty">{sessions.length ? "No sessions match." : "No sessions in this workspace yet."}</div>
        ) : (
          list.map((x, n) => {
            const g = groupLabel(x.updated, now);
            const head = g !== lastGroup ? <div className="group-label">{(lastGroup = g)}</div> : null;
            return (
              <React.Fragment key={x.id}>
                {head}
                <SessionRow s={x} current={x.id === currentId} active={n === sel} onOpen={onClose} />
              </React.Fragment>
            );
          })
        )}
      </div>
      {sessions && <div className="panel-foot muted">{list.length} of {sessions.length} · <kbd>↑</kbd><kbd>↓</kbd> <kbd>Enter</kbd> open · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> new tab</div>}
    </div>
  );
}

// ---------------- stats ----------------

const rate = (v?: number) => (v === undefined ? "—" : `${v.toFixed(1)} tok/s`);
const ms = (v?: number) => (v === undefined ? "—" : fmtDuration(v));

function Row({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span className="muted">{k}</span>
      <span className="tabular">{v}</span>
    </div>
  );
}

function StatsPanel(props: { stats: SessionStats; session: SessionMeta; prefs?: Prefs; commands: State["commands"]; onClose(): void }) {
  const { stats: st, session, prefs, onClose } = props;
  const t = st.tokens;
  const ctxStatus = props.commands.some((c) => c.name === "ctx-status");
  const mc = st.plugins.magicContext;
  return (
    <div className="panel" onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1}>
      <div className="panel-head">
        <Icon name="pulse" />
        <span className="grow ellipsis">Session stats</span>
        <button className="ghost" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="panel-body stats">
        <div className="tiles">
          <div className="tile" title="Generated tokens per second in the most recent step">
            <div className="tile-v tabular">{st.decode.last?.toFixed(1) ?? "—"}</div>
            <div className="tile-k">tok/s, last step</div>
          </div>
          <div className="tile" title="All generated tokens over all generating time">
            <div className="tile-v tabular">{st.decode.avg?.toFixed(1) ?? "—"}</div>
            <div className="tile-k">tok/s, average</div>
          </div>
          <div className="tile" title="Request sent to first token, averaged over steps">
            <div className="tile-v tabular">{ms(st.ttft.avg)}</div>
            <div className="tile-k">to first token</div>
          </div>
        </div>

        <section>
          <h3>Throughput</h3>
          <Row k="Decode, best step" v={rate(st.decode.best)} />
          <Row k="Prefill, average" v={rate(st.prefill.avg)} title="Uncached prompt tokens over time to first token. Includes server-side plugin hooks, so it is a lower bound." />
          <Row k="Time to first token, last" v={ms(st.ttft.last)} />
          <Row k="Model time" v={ms(st.modelTime)} title="Summed over steps, request to end of stream; tools excluded" />
        </section>

        <section>
          <h3>Tokens</h3>
          {st.context !== undefined && <Row k="Context now" v={st.context.toLocaleString()} title="The last step's prompt plus its answer: what the next request starts from" />}
          <Row k="Prompt, uncached" v={t.input.toLocaleString()} />
          <Row k="Prompt, from cache" v={`${t.cacheRead.toLocaleString()}${st.cacheHit !== undefined ? ` (${Math.round(st.cacheHit * 100)}%)` : ""}`} />
          <Row k="Generated" v={t.output.toLocaleString()} />
          {t.reasoning > 0 && <Row k="Reasoning" v={t.reasoning.toLocaleString()} />}
        </section>

        <section>
          <h3>Session</h3>
          <Row k="Turns · steps" v={`${st.turns} · ${st.steps}`} />
          {session.agent && <Row k="Agent" v={session.agent} />}
          {session.model?.id && <Row k="Model" v={`${session.model.id}${session.model.variant ? ` · ${session.model.variant}` : ""}`} />}
          {prefs?.connection && <Row k="Connection" v={prefs.connection === "gateway" ? "API gateway" : "SSH tunnel"} />}
        </section>

        <section>
          <h3>Plugins</h3>
          <div className="plugin">
            <div className="plugin-head">
              <span className="grow">Magic Context</span>
              <span className={`badge ${prefs?.magicContext === false ? "" : "on"}`}>{prefs?.magicContext === false ? "off" : "on"}</span>
            </div>
            {mc.length ? (
              mc.map((c) => <Row key={c.name} k={c.name.replace(/_/g, " ")} v={`${c.calls}${c.errors ? ` · ${c.errors} failed` : ""}`} />)
            ) : (
              <div className="muted small">No ctx_* calls in this session yet.</div>
            )}
            {ctxStatus && !session.parentID && (
              <button className="btn small" onClick={() => (post({ type: "command", name: "ctx-status", text: "" }), onClose())}>
                <Icon name="layers" /> Run /ctx-status
              </button>
            )}
          </div>
          <div className="plugin">
            <div className="plugin-head">
              <span className="grow">Secret guard</span>
              <span className="tabular">{st.plugins.secretGuardBlocks} blocked</span>
            </div>
          </div>
          <div className="plugin">
            <div className="plugin-head">
              <span className="grow">Workers</span>
              <span className="tabular">{st.plugins.dispatches} dispatched</span>
            </div>
            {st.workers.total > 0 && <Row k="Sessions" v={`${st.workers.total}${st.workers.running ? ` · ${st.workers.running} running` : ""}${st.workers.failed ? ` · ${st.workers.failed} failed` : ""}`} />}
          </div>
        </section>

        {st.tools.length > 0 && (
          <section>
            <h3>Tools</h3>
            {st.tools.slice(0, 12).map((c) => (
              <Row key={c.name} k={c.name} v={`${c.calls}${c.errors ? ` · ${c.errors} failed` : ""}`} />
            ))}
          </section>
        )}
        <p className="muted small">Measured from server event times. Throughput includes network buffering on the way here.</p>
      </div>
    </div>
  );
}

function App() {
  const state = useHostState();
  smoothEnabled = state.prefs?.smoothStreaming ?? true;
  const s = state.session;
  const busy = s?.status === "busy";
  const root = state.prefs?.root;
  const [panel, setPanel] = useState<"history" | "stats" | null>(null);
  useEffect(() => {
    if (state.showHistory) setPanel("history");
  }, [state.showHistory]);
  useEffect(() => {
    setPanel((p) => (p === "history" ? null : p));
  }, [s?.id]);
  const stats = useMemo(() => (s ? sessionStats(s, state.messages) : undefined), [s, state.messages]);
  const ctx = stats?.context ?? s?.usage?.input;
  const decode = stats?.decode.last;
  return (
    <div className="app">
      <ServerBanner server={state.server} />
      {s && (
        <div className="header">
          <span className={`status ${s.status}`} />
          <span className="title ellipsis" title={s.title}>{s.title}</span>
          {s.parentID && <span className="badge">worker</span>}
          <button
            className={`stat-chip tabular ${panel === "stats" ? "on" : ""}`}
            title={`${decode !== undefined ? `${decode.toFixed(1)} tokens/s in the last step. ` : ""}${ctx ? `${ctx.toLocaleString()} tokens of context. ` : ""}Click for session stats.`}
            onClick={() => setPanel(panel === "stats" ? null : "stats")}
          >
            <Icon name="pulse" />
            {decode !== undefined && <span>{decode.toFixed(0)} tok/s</span>}
            {decode !== undefined && ctx ? <span className="dim">·</span> : null}
            {ctx ? <span>{fmt(ctx)} ctx</span> : null}
          </button>
          <button className={`ghost ${panel === "history" ? "on" : ""}`} title="Sessions" onClick={() => setPanel(panel === "history" ? null : "history")}><Icon name="history" /></button>
        </div>
      )}
      <div className="main">
        {s ? <Transcript messages={state.messages} showReasoning={state.prefs?.showReasoning ?? false} root={root} busy={busy} /> : <Empty ready={state.server.kind === "ready"} sessions={state.sessions} onBrowse={() => setPanel("history")} />}
        {panel === "history" && <HistoryPanel sessions={state.sessions} currentId={s?.id} onClose={() => setPanel(null)} />}
        {panel === "stats" && s && stats && <StatsPanel stats={stats} session={s} prefs={state.prefs} commands={state.commands} onClose={() => setPanel(null)} />}
      </div>
      {state.error && (
        <div className="event event-error floating"><Icon name="warning" /><span>{state.error}</span></div>
      )}
      <div className="dock">
        {s && <Permissions items={s.permissions} />}
        {s?.forms.map((f) => <FormCard key={f.id} f={f} />)}
        {s && <Tray children={s.children} files={s.changedFiles} stats={s.fileStats} root={root} />}
        <Composer state={state} busy={busy} readOnly={Boolean(s?.parentID)} />
      </div>
    </div>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function relTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A render bug must never leave a blank panel: show it and offer a reload. */
class Boundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner error">
        <div className="banner-text"><Icon name="error" /> <span>The chat view hit an error: {this.state.error.message}</span></div>
        <div className="card-actions">
          <button className="btn primary" onClick={() => this.setState({ error: undefined })}>Reload view</button>
          <button className="btn" onClick={() => post({ type: "showLogs" })}>Show logs</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
