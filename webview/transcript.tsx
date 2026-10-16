// The conversation: user bubbles with their checkpoint actions, assistant
// steps (reasoning, text, tool rows), notices, turn footers, the live phase
// line, and the scroll container that follows them.

import React, { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantMessage, CompactionMessage, Message, ReasoningBlock, ShellMessage, ToolBlock, UserMessage } from "../shared/model";
import { stripMarkers } from "../shared/model";
import type { SessionMeta } from "../shared/protocol";
import { TurnSummary, turnSummary } from "../shared/stats";
import { hidePartialMarker } from "./smooth";
import { post } from "./host";
import { LiveMarkdown, useSmoothText } from "./markdown";
import { fmt, fmtDuration, Icon, rel, useTicker } from "./util";

/** What tool rows need to know about the session they are in. */
export interface ToolEnv {
  root?: string;
  /** Names of the MCP servers, to recognise `<server>_<tool>` calls. */
  mcp: string[];
}
export const ToolContext = createContext<ToolEnv>({ mcp: [] });

export const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
export const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.replace(/\n$/, "").split("\n").length : 0);

export interface ToolView {
  icon: string;
  verb: string;
  target?: string;
  mono?: boolean;
  path?: string;
  adds?: number;
  dels?: number;
}

const VSCODE_TOOLS: Record<string, { icon: string; target: string }> = {
  diagnostics: { icon: "warning", target: "problems" },
  open_editors: { icon: "multiple-windows", target: "open editors" },
  selection: { icon: "selection", target: "selection" },
};

/** `<server>_<tool>` for a known MCP server, longest server name first. */
function mcpTool(name: string, servers: string[]): { server: string; tool: string } | undefined {
  const server = [...servers].sort((a, b) => b.length - a.length).find((s) => name.startsWith(s.replace(/[^a-zA-Z0-9_-]/g, "_") + "_"));
  return server ? { server, tool: name.slice(server.length + 1) } : undefined;
}

export function describeTool(t: ToolBlock, env: ToolEnv): ToolView {
  const i = (t.input ?? {}) as Record<string, any>;
  const path = (i.path ?? i.filePath) as string | undefined;
  const p = path ? rel(path, env.root) : undefined;
  switch (t.name) {
    case "read": {
      const from = Number(i.offset ?? 0);
      const lines = i.limit ? ` · lines ${from + 1}–${from + Number(i.limit)}` : from ? ` · from line ${from + 1}` : "";
      return { icon: "file", verb: "Read", target: p && p + lines, path };
    }
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
    case "execute": {
      // Code Mode: the model wrote a script that calls MCP tools.
      const calls = t.calls ?? [];
      const names = [...new Set(calls.map((c) => c.tool))];
      return { icon: "plug", verb: "MCP", target: names.length ? names.join(", ") + (calls.length > names.length ? ` (${calls.length} calls)` : "") : "code mode", mono: true };
    }
    case "list_mcp_resources":
    case "read_mcp_resource":
      return { icon: "plug", verb: "MCP", target: t.name === "read_mcp_resource" ? String(i.uri ?? "resource") : "list resources" };
    default: {
      if (t.name.startsWith("ctx_")) return { icon: "layers", verb: "Context", target: t.name.slice(4).replace(/_/g, " ") };
      const m = mcpTool(t.name, env.mcp);
      if (m?.server === "vscode") {
        const known = VSCODE_TOOLS[m.tool];
        return { icon: known?.icon ?? "vscode", verb: "Asked VS Code", target: (known?.target ?? m.tool.replace(/_/g, " ")) + (i.path ? ` in ${rel(String(i.path), env.root)}` : "") };
      }
      if (m) return { icon: "plug", verb: m.server, target: m.tool.replace(/_/g, " ") };
      return { icon: "tools", verb: t.name, target: p ?? (i.query || i.pattern || undefined) };
    }
  }
}

/** "4s" once a call has run long enough to be worth a number. */
function Elapsed({ t }: { t: ToolBlock }) {
  useTicker(t.status === "running" || t.status === "pending");
  if (!t.started) return null;
  const ms = (t.ended ?? Date.now()) - t.started;
  return ms >= 2000 ? <span className="step-time tabular">{fmtDuration(ms)}</span> : null;
}

export const ToolRow = memo(function ToolRow({ t }: { t: ToolBlock }) {
  const env = useContext(ToolContext);
  const [open, setOpen] = useState(false);
  const v = describeTool(t, env);
  const i = (t.input ?? {}) as Record<string, any>;
  const body = t.status === "error" ? t.error : t.output;
  const editPreview = (t.name === "edit" || t.name === "multiedit") && (i.oldString || i.newString);
  const expandable = Boolean(body || editPreview || (v.mono && v.target) || t.calls?.length);
  const firstError = t.status === "error" && t.error ? t.error.trim().split("\n")[0] : undefined;
  return (
    <div className={`step step-${t.status}`}>
      <div
        className={`step-head ${expandable ? "expandable" : ""}`}
        onClick={() => expandable && setOpen(!open)}
        role={expandable ? "button" : undefined}
        aria-expanded={expandable ? open : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={(e) => expandable && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
      >
        <span className="step-verb">{v.verb}</span>
        {v.target && <span className={`step-target ${v.mono ? "mono" : ""}`} title={v.target}>{v.target}</span>}
        {(v.adds || v.dels) && t.status === "completed" ? (
          <span className="stat">
            {v.adds ? <span className="add">+{v.adds}</span> : null}
            {v.dels ? <span className="del">−{v.dels}</span> : null}
          </span>
        ) : null}
        <Elapsed t={t} />
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
      {firstError && !open && <div className="step-error-line" title={t.error}>{firstError}</div>}
      {open && (
        <div className="step-body">
          {t.calls?.length ? (
            <div className="calls">
              {t.calls.map((c, n) => (
                <div key={n} className={`call call-${c.status}`}><Icon name={c.status === "error" ? "error" : c.status === "completed" ? "pass" : "loading"} /> <span className="mono-sm">{c.tool}</span></div>
              ))}
            </div>
          ) : null}
          {editPreview ? (
            <pre className="diff">
              {i.oldString ? String(i.oldString).replace(/\n$/, "").split("\n").map((l, n) => <div key={`o${n}`} className="del">{l || " "}</div>) : null}
              {i.newString ? String(i.newString).replace(/\n$/, "").split("\n").map((l, n) => <div key={`n${n}`} className="add">{l || " "}</div>) : null}
            </pre>
          ) : body || v.verb === "Run" ? (
            <pre>
              {v.verb === "Run" ? <span className="prompt">$ {v.target}{body ? "\n" : ""}</span> : null}
              {body ? (body.length > 20000 ? body.slice(0, 20000) + "\n…" : body) : null}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
});

export const Reasoning = memo(function Reasoning({ b, defaultOpen }: { b: ReasoningBlock; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useTicker(!b.done);
  if (!b.text.trim() && b.done) return null;
  const secs = b.started ? Math.max(1, Math.round(((b.ended ?? Date.now()) - b.started) / 1000)) : undefined;
  // A thought of a second or two between tool calls is routine; keep it quiet.
  const brief = b.done && (secs ?? 0) <= 2 && b.text.length < 600;
  return (
    <div className={`thought ${open ? "open" : ""} ${brief ? "brief" : ""}`}>
      <div className="thought-head" onClick={() => setOpen(!open)} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}>
        {b.done ? <span>Thought{secs ? ` for ${secs}s` : ""}</span> : <span className="shimmer">Thinking{secs ? ` · ${secs}s` : "…"}</span>}
        <Icon name="chevron-right" className="thought-chevron" />
      </div>
      {open && <ThoughtBody text={b.text} live={!b.done} />}
    </div>
  );
});

export function ThoughtBody({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text, live);
  return <div className="thought-body">{shown.trim()}</div>;
}

/** Consecutive tool calls render as one timeline group, like a run of steps. */
export const AssistantView = memo(function AssistantView({ m, showReasoning }: { m: AssistantMessage; showReasoning: boolean }) {
  const groups: React.ReactNode[] = [];
  let steps: ToolBlock[] = [];
  const flush = (key: string) => {
    if (!steps.length) return;
    const run = steps;
    steps = [];
    groups.push(
      <div className={`steps ${run.length === 1 ? "single" : ""}`} key={key}>
        {run.map((t) => <ToolRow key={t.id} t={t} />)}
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

/** A message the user sent, with the checkpoint actions on hover. */
const UserView = memo(function UserView({ m, actions, reverted }: { m: UserMessage; actions: boolean; reverted: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`user ${reverted ? "reverted" : ""}`}>
      {actions && (
        <div className="user-actions" role="toolbar" aria-label="Message actions">
          <button className="ghost" title="Rewind here: restore the files and set this turn and the rest aside (undo with Redo)" onClick={() => post({ type: "rewind", messageID: m.id, files: true })}><Icon name="discard" /></button>
          <button className="ghost" title="Edit and resend: rewind here and put this message back in the input" onClick={() => post({ type: "editMessage", messageID: m.id })}><Icon name="edit" /></button>
          <button className="ghost" title="Fork: a new session with the conversation up to here" onClick={() => post({ type: "fork", messageID: m.id })}><Icon name="repo-forked" /></button>
          <button className="ghost" title="Copy" onClick={() => (post({ type: "copy", text: m.text }), setCopied(true), setTimeout(() => setCopied(false), 1200))}><Icon name={copied ? "check" : "copy"} /></button>
        </div>
      )}
      <div className="user-bubble">
        {m.text}
        {m.files?.length ? (
          <div className="user-files">
            {m.files.map((f) => (
              <span key={f} className="user-file" title={f}><Icon name="file" /> {f.split("/").pop()}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function RevertBanner({ files }: { files: string[] }) {
  return (
    <div className="revert-banner" role="status">
      <Icon name="history" />
      <span className="grow">
        Rewound to here{files.length ? ` · ${files.length} file${files.length > 1 ? "s" : ""} restored` : ""}. Your next message continues from this point.
      </span>
      <button className="btn small" title="Bring the conversation and files back" onClick={() => post({ type: "revertUndo" })}>Redo</button>
      <button className="btn small" title="Delete the set-aside messages now" onClick={() => post({ type: "revertCommit" })}>Discard</button>
    </div>
  );
}

/** A `!command` the user ran: the command, its exit status and output. */
function ShellView({ m }: { m: ShellMessage }) {
  const [open, setOpen] = useState(true);
  const failed = m.status !== "running" && m.exit !== 0;
  return (
    <div className={`step shell-run ${m.status === "running" ? "step-running" : failed ? "step-error" : "step-completed"}`}>
      <div className="step-head expandable" onClick={() => setOpen(!open)}>
        <span className="step-verb">You ran</span>
        <span className="step-target mono" title={m.command}>{m.command}</span>
        {m.status !== "running" && <span className={`badge ${failed ? "err" : ""}`}>{m.status === "exited" ? `exit ${m.exit ?? "?"}` : m.status}</span>}
        <Icon name="chevron-right" className={`step-chevron ${open ? "open" : ""}`} />
      </div>
      {open && m.output ? (
        <div className="step-body"><pre>{m.output.length > 20000 ? m.output.slice(0, 20000) + "\n…" : m.output}</pre></div>
      ) : null}
    </div>
  );
}

/** Where the conversation was summarised to free context. */
function CompactionView({ m }: { m: CompactionMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`compaction ${m.status}`}>
      <div className="compaction-line" onClick={() => m.summary && setOpen(!open)}>
        <Icon name={m.status === "failed" ? "warning" : "fold"} />
        <span>{m.status === "failed" ? "Compaction failed" : m.status === "running" ? "Compacting…" : m.reason === "manual" ? "Conversation compacted" : "Context compacted automatically"}</span>
        {m.summary && <Icon name="chevron-right" className={`step-chevron ${open ? "open" : ""}`} />}
      </div>
      {open && m.summary && <div className="compaction-summary">{m.summary}</div>}
    </div>
  );
}

// ---------------- transcript ----------------

/**
 * What the turn is doing when no text is streaming: waiting on the model
 * (queue and prefill, which a cold prompt makes long on a local cluster),
 * running a tool, retrying, or compacting.
 */
function phase(session: SessionMeta, messages: Message[], env: ToolEnv, now: number): { label: string; detail?: string } {
  if (session.compacting) return { label: "Compacting the conversation" };
  if (session.retry) {
    const secs = Math.max(0, Math.ceil((session.retry.at - now) / 1000));
    return { label: secs ? `Retrying in ${secs}s` : "Retrying", detail: `attempt ${session.retry.attempt} · ${session.retry.message}` };
  }
  const last = [...messages].reverse().find((m) => m.kind === "assistant" || m.kind === "user");
  if (last?.kind === "assistant" && !last.done) {
    const running = last.blocks.filter((b): b is ToolBlock => b.type === "tool" && (b.status === "running" || b.status === "pending"));
    if (running.length) {
      const v = describeTool(running[running.length - 1], env);
      return { label: `${v.verb}${running.length > 1 ? ` + ${running.length - 1} more` : ""}`, detail: v.target };
    }
  }
  return { label: "Waiting for the model" };
}

function Working({ since, session, messages, env }: { since: number; session: SessionMeta; messages: Message[]; env: ToolEnv }) {
  useTicker(true);
  const now = Date.now();
  const secs = Math.max(0, Math.round((now - since) / 1000));
  const p = phase(session, messages, env, now);
  const slow = p.label === "Waiting for the model" && secs >= 20;
  return (
    <div className="working" aria-live="off">
      <span className="dots"><i /><i /><i /></span>
      <span className="shimmer">{p.label}</span>
      {p.detail && <span className="working-detail ellipsis" title={p.detail}>{p.detail}</span>}
      <span className="muted tabular">{secs}s · esc to stop</span>
      {slow && <div className="working-hint">A cold prompt cache or a busy cluster makes the first token slow; Tellico has four request slots in all.</div>}
    </div>
  );
}

/** Under the last step of a finished turn: how much it generated and how fast. */
export function TurnFooter({ t }: { t: TurnSummary }) {
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
export function turnFooters(messages: Message[], busy: boolean): Map<string, TurnSummary> {
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

/** Messages this far from the end are skipped by layout until scrolled to. */
const SETTLED = 8;

export function Transcript(props: { session: SessionMeta; messages: Message[]; showReasoning: boolean; env: ToolEnv; busy: boolean; canRewind: boolean }) {
  const { session, messages, showReasoning, env, busy } = props;
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Following the bottom stops the moment the user scrolls up (one wheel
  // tick is enough) and resumes only when they come back to the bottom.
  const stick = useRef(true);
  const ours = useRef(false);
  const [detached, setDetached] = useState(false);
  const busySince = useRef(0);
  if (busy && !busySince.current) busySince.current = Date.now();
  if (!busy) busySince.current = 0;
  // Instant: a smooth scroll fires scroll events mid-way that would read as the user scrolling up.
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    ours.current = true;
    el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  });
  // Paced text grows inside its own component, without re-rendering this one,
  // so follow the content's height rather than our own renders.
  useEffect(() => {
    const body = inner.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stick.current && toBottom());
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  // A different session starts at its end.
  useEffect(() => {
    stick.current = true;
    setDetached(false);
    toBottom();
  }, [session.id]);
  const detach = () => {
    stick.current = false;
    setDetached(true);
  };
  const onScroll = () => {
    const el = ref.current!;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 4) {
      stick.current = true;
      setDetached(false);
    } else if (!ours.current && gap > 48) detach();
    ours.current = false;
  };
  const footers = useMemo(() => turnFooters(messages, busy), [messages, busy]);
  const last = messages[messages.length - 1];
  const streaming = Boolean(last && last.kind === "assistant" && !last.done && last.blocks.some((b) => b.type !== "tool" && !b.done));
  const revertAt = session.revert ? messages.findIndex((m) => m.id === session.revert!.messageID) : -1;
  return (
    <ToolContext.Provider value={env}>
      <div className="transcript-wrap">
        <div
          className="transcript"
          ref={ref}
          onScroll={onScroll}
          onWheel={(e) => e.deltaY < 0 && detach()}
          onKeyDown={(e) => ["PageUp", "ArrowUp", "Home"].includes(e.key) && detach()}
          tabIndex={-1}
        >
          <div className="transcript-inner" ref={inner} role="log" aria-label="Conversation">
            {messages.map((m, n) => {
              const reverted = revertAt >= 0 && n >= revertAt;
              const cls = `${n < messages.length - SETTLED ? "settled" : ""} ${reverted ? "reverted" : ""}`;
              const node =
                m.kind === "user" ? (
                  <UserView m={m} actions={props.canRewind && !busy && !reverted} reverted={reverted} />
                ) : m.kind === "assistant" ? (
                  <>
                    <AssistantView m={m} showReasoning={showReasoning} />
                    {footers.has(m.id) && <TurnFooter t={footers.get(m.id)!} />}
                  </>
                ) : m.kind === "shell" ? (
                  <ShellView m={m} />
                ) : m.kind === "compaction" ? (
                  <CompactionView m={m} />
                ) : (
                  <div className={`event event-${m.level}`}>
                    <Icon name={m.level === "error" ? "warning" : m.level === "warn" ? "shield" : m.text.startsWith("Worker") ? "pass" : "info"} />
                    <span>{m.level === "warn" ? <><b>Tellico guard: </b>{m.text}</> : m.text}</span>
                  </div>
                );
              return (
                <React.Fragment key={m.id}>
                  {n === revertAt && <RevertBanner files={session.revert!.files} />}
                  <div className={`msg ${cls}`}>{node}</div>
                </React.Fragment>
              );
            })}
            {busy && !streaming && <Working since={busySince.current} session={session} messages={messages} env={env} />}
          </div>
        </div>
        {detached && (
          <button className="jump" onClick={() => ((stick.current = true), setDetached(false), toBottom())}>
            <Icon name="arrow-down" /> {busy ? "Follow the latest" : "Jump to latest"}
          </button>
        )}
      </div>
    </ToolContext.Provider>
  );
}
