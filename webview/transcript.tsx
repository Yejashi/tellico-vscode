// The conversation: user bubbles, assistant steps (reasoning, text, tool
// rows), notices, turn footers, and the scroll container that follows them.

import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantMessage, Message, ReasoningBlock, ToolBlock } from "../shared/model";
import { stripMarkers } from "../shared/model";
import { TurnSummary, turnSummary } from "../shared/stats";
import { hidePartialMarker } from "./smooth";
import { post } from "./host";
import { LiveMarkdown, useSmoothText } from "./markdown";
import { fmt, fmtDuration, Icon, rel, useTicker } from "./util";

// ---------------- tool rows ----------------

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

export function describeTool(t: ToolBlock, root?: string): ToolView {
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

export const ToolRow = memo(function ToolRow({ t, root }: { t: ToolBlock; root?: string }) {
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

export const Reasoning = memo(function Reasoning({ b, defaultOpen }: { b: ReasoningBlock; defaultOpen: boolean }) {
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

export function ThoughtBody({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text, live);
  return <div className="thought-body">{shown.trim()}</div>;
}

/** Consecutive tool calls render as one timeline group, like a run of steps. */
export const AssistantView = memo(function AssistantView({ m, showReasoning, root }: { m: AssistantMessage; showReasoning: boolean; root?: string }) {
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

export function Working({ since }: { since: number }) {
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

export function Transcript({ messages, showReasoning, root, busy }: { messages: Message[]; showReasoning: boolean; root?: string; busy: boolean }) {
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
