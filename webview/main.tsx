import "./style.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AssistantMessage, Message } from "../shared/model";
import { sessionStats, turnSummary } from "../shared/stats";
import { PanelName, post, saveState, useHostState } from "./host";
import { setSmooth } from "./markdown";
import { ToolEnv, Transcript } from "./transcript";
import { Permissions, FormCard, Tray } from "./dock";
import { Composer } from "./composer";
import { ContextBar, Empty, HistoryPanel, ServerBanner, StatsPanel, ToolsPanel } from "./panels";
import { fmt, Icon } from "./util";

/** The decode rate of the latest turn that generated anything: what its footer shows. */
function latestTurnRate(messages: Message[]): number | undefined {
  let steps: AssistantMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "assistant") steps.unshift(m);
    else if (m.kind === "user" && steps.length) break;
  }
  return steps.length ? turnSummary(steps)?.decode : undefined;
}

/** Announces the moments that matter to a screen reader, not every token. */
function useAnnouncement(status: string | undefined, waiting: number): string {
  const [text, setText] = useState("");
  const prev = useRef({ status, waiting });
  useEffect(() => {
    const p = prev.current;
    if (p.status === "busy" && status === "idle") setText("Tellico finished.");
    else if (p.status === "busy" && status === "error") setText("Tellico stopped with an error.");
    else if (waiting > p.waiting) setText("Tellico is waiting for your answer.");
    prev.current = { status, waiting };
  }, [status, waiting]);
  return text;
}

function App() {
  const state = useHostState();
  setSmooth(state.prefs?.smoothStreaming ?? true);
  const s = state.session;
  const busy = s?.status === "busy";
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (state.panel) setPanel(state.panel.name);
  }, [state.panel?.n]);
  useEffect(() => {
    setPanel((p) => (p === "history" ? null : p));
    // An editor tab reopens on this session after a reload; not before the
    // host has said which one it shows, or a slow start would forget it.
    if (state.known) saveState({ sessionID: s?.id });
  }, [s?.id, state.known]);
  useEffect(() => {
    if (!state.error) return;
    setToast(state.error.message);
    const t = setTimeout(() => setToast(undefined), 10_000);
    return () => clearTimeout(t);
  }, [state.error?.n]);
  const stats = useMemo(() => (s ? sessionStats(s, state.messages) : undefined), [s, state.messages]);
  const env: ToolEnv = useMemo(() => ({ root: state.prefs?.root, mcp: state.mcp.map((m) => m.name) }), [state.prefs?.root, state.mcp]);
  const ctx = stats?.context ?? s?.usage?.input;
  const limit = state.prefs?.contextLimit;
  const decode = busy ? stats?.decode.last : latestTurnRate(state.messages) ?? stats?.decode.last;
  const mcpTrouble = state.mcp.some((m) => m.status === "failed" || m.status === "needs_auth") || state.mcpIssues.length > 0;
  const waiting = (s?.permissions.length ?? 0) + (s?.forms.length ?? 0);
  const announcement = useAnnouncement(s?.status, waiting);
  const toggle = (p: PanelName) => setPanel(panel === p ? null : p);
  return (
    <div className="app">
      <div className="sr-only" aria-live="polite">{announcement}</div>
      <ServerBanner server={state.server} />
      {s ? (
        <div className="header">
          <span className={`status ${s.status}`} title={s.status === "busy" ? "Working" : s.status === "error" ? "Stopped with an error" : "Idle"} />
          <span className="title ellipsis" title={`${s.title}\nDouble-click to rename`} onDoubleClick={() => !s.parentID && post({ type: "renameSession", id: s.id })}>{s.title}</span>
          {s.parentID && <span className="badge">worker</span>}
          {state.prefs?.branch && (
            <span className="branch ellipsis" title={`On branch ${state.prefs.branch}`}><Icon name="git-branch" /> {state.prefs.branch}</span>
          )}
          <button
            className={`stat-chip tabular ${panel === "stats" ? "on" : ""}`}
            title={`${decode !== undefined ? `${decode.toFixed(1)} tokens/s ${busy ? "in the current step" : "in the last turn"}. ` : ""}${ctx ? `${ctx.toLocaleString()}${limit ? ` of ${limit.toLocaleString()}` : ""} tokens of context. ` : ""}Click for session stats.`}
            onClick={() => toggle("stats")}
          >
            <Icon name="pulse" />
            {decode !== undefined && <span>{decode.toFixed(0)} tok/s</span>}
            {decode !== undefined && ctx ? <span className="dim">·</span> : null}
            {ctx && limit ? <ContextBar used={ctx} limit={limit} /> : ctx ? <span>{fmt(ctx)} ctx</span> : null}
            {ctx && limit ? <span>{Math.round((ctx / limit) * 100)}%</span> : null}
          </button>
          <button className={`ghost ${panel === "mcp" ? "on" : ""}`} title={mcpTrouble ? "Tools: an MCP server needs attention" : "Tools: MCP servers and permissions"} onClick={() => toggle("mcp")}>
            <Icon name="plug" />
            {mcpTrouble && <span className="dot-alert" />}
          </button>
          <button className={`ghost ${panel === "history" ? "on" : ""}`} title="Sessions" onClick={() => toggle("history")}><Icon name="history" /></button>
        </div>
      ) : null}
      <div className="main">
        {s ? (
          <Transcript
            session={s}
            messages={state.messages}
            showReasoning={state.prefs?.showReasoning ?? false}
            env={env}
            busy={busy}
            canRewind={!s.parentID && state.server.kind === "ready"}
          />
        ) : (
          <Empty ready={state.server.kind === "ready"} sessions={state.sessions} onBrowse={() => setPanel("history")} onTools={() => setPanel("mcp")} />
        )}
        {panel === "history" && <HistoryPanel sessions={state.sessions} currentId={s?.id} onClose={() => setPanel(null)} />}
        {panel === "stats" && s && stats && <StatsPanel stats={stats} session={s} prefs={state.prefs} commands={state.commands} onClose={() => setPanel(null)} />}
        {panel === "mcp" && <ToolsPanel servers={state.mcp} issues={state.mcpIssues} saved={state.savedPermissions} onClose={() => setPanel(null)} />}
      </div>
      {toast && (
        <div className="event event-error floating" role="alert">
          <Icon name="warning" />
          <span className="grow">{toast}</span>
          <button className="ghost" title="Dismiss" onClick={() => setToast(undefined)}><Icon name="close" /></button>
        </div>
      )}
      <div className="dock">
        {s && <Permissions items={s.permissions} leadID={s.id} />}
        {s?.forms.map((f) => <FormCard key={f.id} f={f} />)}
        {s && <Tray children={s.children} files={s.changedFiles} stats={s.fileStats} root={state.prefs?.root} />}
        <Composer state={state} busy={busy} readOnly={Boolean(s?.parentID)} pending={s?.pending ?? []} messages={state.messages} />
      </div>
    </div>
  );
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
