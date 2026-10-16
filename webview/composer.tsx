// The input box and its footer menus (agent, node, thinking, connection).

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ThinkLevel } from "../shared/model";
import { THINK_LEVELS } from "../shared/model";
import { post, State, vscode } from "./host";
import { Icon } from "./util";

// ---------------- composer ----------------

export interface MenuItem<T> {
  value: T;
  label: string;
  detail?: string;
}

/** A footer button that opens a small menu above it, in place of a native <select>. */
export function MenuButton<T extends string | number>(props: {
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

export const THINK_DETAIL: Record<ThinkLevel, string> = {
  off: "No reasoning, fastest",
  low: "Brief reasoning",
  medium: "Balanced, the default",
  xhigh: "The most the template allows",
};

export function Composer(props: { state: State; busy: boolean; readOnly: boolean }) {
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
