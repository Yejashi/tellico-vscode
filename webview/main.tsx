import "./style.css";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import type { AssistantMessage, ChildSession, FormQuestion, Message, PermissionRequest, ReasoningBlock, ThinkLevel, ToolBlock } from "../shared/model";
import { stripMarkers, THINK_LEVELS } from "../shared/model";
import type { EditorContext, HostToWebview, Prefs, ServerStatus, SessionMeta, WebviewToHost } from "../shared/protocol";

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
}

const initial: State = { server: { kind: "starting" }, commands: [], context: {}, messages: [] };

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
      {open && <div className="thought-body">{b.text.trim()}</div>}
    </div>
  );
});

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
      const text = stripMarkers(b.text);
      if (text.trim()) groups.push(<Markdown key={i} text={text} />);
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

function Transcript({ messages, showReasoning, root, busy }: { messages: Message[]; showReasoning: boolean; root?: string; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busySince = useRef(0);
  if (busy && !busySince.current) busySince.current = Date.now();
  if (!busy) busySince.current = 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const last = messages[messages.length - 1];
  const streaming = Boolean(last && last.kind === "assistant" && !last.done && last.blocks.some((b) => b.type !== "tool" && !b.done));
  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="transcript-inner">
        {messages.map((m) =>
          m.kind === "user" ? (
            <div key={m.id} className="user">
              <div className="user-bubble">{m.text}</div>
            </div>
          ) : m.kind === "assistant" ? (
            <AssistantView key={m.id} m={m} showReasoning={showReasoning} root={root} />
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

function Empty({ ready }: { ready: boolean }) {
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
      <div className="hints">
        <span><kbd>/</kbd> commands</span>
        <span><kbd>Alt</kbd>+<kbd>K</kbd> reference selection</span>
        <button className="link" onClick={() => post({ type: "history" })}><Icon name="history" /> Resume a session</button>
      </div>
    </div>
  );
}

function App() {
  const state = useHostState();
  const s = state.session;
  const busy = s?.status === "busy";
  const root = state.prefs?.root;
  return (
    <div className="app">
      <ServerBanner server={state.server} />
      {s && (
        <div className="header">
          <span className={`status ${s.status}`} />
          <span className="title ellipsis" title={s.title}>{s.title}</span>
          {s.parentID && <span className="badge">worker</span>}
          {s.usage && s.usage.input > 0 && (
            <span className="usage tabular" title={`${s.usage.input.toLocaleString()} tokens of context, ${s.usage.output.toLocaleString()} generated`}>
              {fmt(s.usage.input)} ctx
            </span>
          )}
        </div>
      )}
      {s ? <Transcript messages={state.messages} showReasoning={state.prefs?.showReasoning ?? false} root={root} busy={busy} /> : <Empty ready={state.server.kind === "ready"} />}
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
