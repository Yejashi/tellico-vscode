// Whole-panel views: the server banner, the welcome screen, the session
// browser and the session stats.

import React, { useEffect, useState } from "react";
import type { Prefs, ServerStatus, SessionMeta, SessionSummary } from "../shared/protocol";
import type { SessionStats } from "../shared/stats";
import { post, State } from "./host";
import { DAY, fmtDuration, Icon, Logo, relTime } from "./util";

// ---------------- app ----------------

export function ServerBanner({ server }: { server: ServerStatus }) {
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

export const SUGGESTIONS = [
  { icon: "book", text: "Explain how this file works" },
  { icon: "bug", text: "Find and fix the bug in this file" },
  { icon: "beaker", text: "Write tests for this file and run them" },
  { icon: "git-pull-request", text: "Review my uncommitted changes" },
];

export function Empty({ ready, sessions, onBrowse }: { ready: boolean; sessions?: SessionSummary[]; onBrowse(): void }) {
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

export const modeOf = (agent?: string) => /^(build|orchestrate)-tellico-([01])$/.exec(agent ?? "");

export function SessionRow({ s, current, active, compact, onOpen }: { s: SessionSummary; current?: boolean; active?: boolean; compact?: boolean; onOpen?(): void }) {
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


export function groupLabel(t: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Previous 7 days";
  if (t >= today - 30 * DAY) return "Previous 30 days";
  return "Older";
}

export function HistoryPanel({ sessions, currentId, onClose }: { sessions?: SessionSummary[]; currentId?: string; onClose(): void }) {
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

export const rate = (v?: number) => (v === undefined ? "—" : `${v.toFixed(1)} tok/s`);
export const ms = (v?: number) => (v === undefined ? "—" : fmtDuration(v));

export function Row({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span className="muted">{k}</span>
      <span className="tabular">{v}</span>
    </div>
  );
}

export function StatsPanel(props: { stats: SessionStats; session: SessionMeta; prefs?: Prefs; commands: State["commands"]; onClose(): void }) {
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
