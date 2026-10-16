// What sits above the composer: the workers / changed-files tray and the
// permission and question cards.

import React, { useState } from "react";
import type { ChildSession, FormQuestion, PermissionRequest } from "../shared/model";
import type { SessionMeta } from "../shared/protocol";
import { post } from "./host";
import { Icon, rel } from "./util";

// ---------------- tray: workers + changes ----------------

export function Stat({ add, del }: { add: number; del: number }) {
  if (!add && !del) return null;
  return (
    <span className="stat">
      {add ? <span className="add">+{add}</span> : null}
      {del ? <span className="del">−{del}</span> : null}
    </span>
  );
}

export function Tray({ children, files, stats, root }: { children: ChildSession[]; files: string[]; stats?: SessionMeta["fileStats"]; root?: string }) {
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
              {c.status === "busy" && (
                <button className="ghost" title="Stop this worker" onClick={(e) => (e.stopPropagation(), post({ type: "stopWorker", id: c.id }))}><Icon name="debug-stop" /></button>
              )}
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

export function Permissions({ items, leadID }: { items: PermissionRequest[]; leadID: string }) {
  return (
    <>
      {items.map((p) => (
        <div key={p.id} className="card" role="alertdialog" aria-label={`Permission: ${p.action}`}>
          <div className="card-title">
            <Icon name="shield" /> Allow {p.action.replace(/_/g, " ")}?
            {p.sessionID !== leadID && <span className="badge">a worker asks</span>}
          </div>
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

export function FormCard({ f }: { f: FormQuestion }) {
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
