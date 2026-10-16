import "./style.css";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { sessionStats } from "../shared/stats";
import { post, useHostState } from "./host";
import { setSmooth } from "./markdown";
import { Transcript } from "./transcript";
import { Permissions, FormCard, Tray } from "./dock";
import { Composer } from "./composer";
import { Empty, HistoryPanel, ServerBanner, StatsPanel } from "./panels";
import { fmt, Icon } from "./util";

function App() {
  const state = useHostState();
  setSmooth(state.prefs?.smoothStreaming ?? true);
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
