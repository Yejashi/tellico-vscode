// The input box: drafts per session, @-file and /command completion, `!`
// shell commands, pasted images, the queue of prompts waiting behind a busy
// turn, and the footer menus (agent, node, thinking, connection).

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message, PendingInput, ThinkLevel } from "../shared/model";
import { THINK_LEVELS } from "../shared/model";
import type { Attachment } from "../shared/protocol";
import { post, saveState, State, vscode } from "./host";
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

interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  icon: string;
  /** Replaces the token being completed. */
  insert: string;
}

/** The token being completed at the caret: a leading /command or an @path. */
function completionAt(text: string, caret: number): { kind: "slash" | "mention"; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[1], start: 0 };
  const at = /(^|[\s([{"'`])@((?:[^\s@]|\\ )*)$/.exec(before);
  if (at) return { kind: "mention", query: at[2].replace(/\\ /g, " "), start: before.length - at[2].length - 1 };
  return undefined;
}

const escapePath = (p: string) => p.replace(/ /g, "\\ ");

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const MAX_IMAGE = 8 * 1024 * 1024;

export function Composer(props: { state: State; busy: boolean; readOnly: boolean; pending: PendingInput[]; messages: Message[] }) {
  const { state, busy, readOnly, pending } = props;
  const prefs = state.prefs;
  const key = state.session?.id ?? "new";
  const drafts = (): Record<string, string> => vscode.getState()?.drafts ?? {};
  const [text, setText] = useState<string>(() => drafts()[key] ?? vscode.getState()?.draft ?? "");
  const [attach, setAttach] = useState(true);
  const [images, setImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [hint, setHint] = useState<string>();
  const [sel, setSel] = useState(0);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const loadedKey = useRef(key);

  // Each session keeps its own draft; switching sessions never loses one.
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setText(drafts()[key] ?? "");
    setImages([]);
  }, [key]);
  useEffect(() => {
    const d = drafts();
    if (text) d[key] = text;
    else delete d[key];
    saveState({ drafts: d, draft: undefined });
  }, [text, key]);
  useEffect(() => {
    if (!state.insert) return;
    const { text: t, replace } = state.insert;
    setText((cur) => (replace ? t : (cur && !/\s$/.test(cur) ? cur + " " : cur) + t));
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  }, [state.insert?.n]);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(undefined), 5000);
    return () => clearTimeout(t);
  }, [hint]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  const completion = completionAt(text, caret);
  const allCommands = useMemo(
    () => [...THINK_LEVELS.map((l) => ({ name: `think-${l}`, description: `Thinking: ${THINK_DETAIL[l].toLowerCase()}` })), ...state.commands],
    [state.commands],
  );
  const mentionQuery = completion?.kind === "mention" ? completion.query : undefined;
  useEffect(() => {
    if (mentionQuery === undefined) return;
    const t = setTimeout(() => post({ type: "findFiles", query: mentionQuery }), mentionQuery ? 90 : 0);
    return () => clearTimeout(t);
  }, [mentionQuery]);

  let suggestions: Suggestion[] = [];
  if (completion?.kind === "slash") {
    suggestions = allCommands
      .filter((c) => c.name.startsWith(completion.query))
      .slice(0, 10)
      .map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, icon: c.name.includes(":") ? "plug" : "symbol-event", insert: `/${c.name} ` }));
  } else if (completion?.kind === "mention" && state.fileMatches && state.fileMatches.query === completion.query) {
    suggestions = state.fileMatches.items.map((f) => {
      const name = f.path.split("/").filter(Boolean).pop() ?? f.path;
      const dir = f.path.slice(0, f.path.length - name.length - (f.path.endsWith("/") ? 1 : 0)).replace(/\/$/, "");
      return {
        key: f.path,
        label: name + (f.type === "directory" ? "/" : ""),
        detail: dir || undefined,
        icon: f.type === "directory" ? "folder" : "file",
        insert: `@${escapePath(f.path)} `,
      };
    });
  }
  const menuKey = completion ? `${completion.kind}:${completion.start}:${completion.query}` : "";
  if (menuKey === dismissed) suggestions = [];
  useEffect(() => setSel(0), [menuKey]);

  const accept = (sg: Suggestion) => {
    if (!completion) return;
    const next = text.slice(0, completion.start) + sg.insert + text.slice(caret);
    const pos = completion.start + sg.insert.length;
    setText(next);
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const send = (delivery?: "steer" | "queue") => {
    if (!text.trim() || readOnly) return;
    const attachments: Attachment[] = images.map((i) => ({ kind: "image", name: i.name, dataUrl: i.dataUrl }));
    post({ type: "send", text, attachContext: attach, delivery, attachments });
    setText("");
    setImages([]);
  };

  const addImages = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return false;
    if (!prefs?.images) {
      setHint("The Tellico model reads text only; images can't be attached.");
      return true;
    }
    for (const f of imgs) {
      if (f.size > MAX_IMAGE) {
        setHint(`${f.name || "Image"} is over 8 MB.`);
        continue;
      }
      const dataUrl = await readAsDataUrl(f);
      setImages((cur) => [...cur, { name: f.name || `pasted-${cur.length + 1}.png`, dataUrl }]);
    }
    return true;
  };

  const onPaste = (e: React.ClipboardEvent) => {
    // Office apps put both text and a picture of it on the clipboard: text wins.
    if (e.clipboardData.getData("text/plain")) return;
    const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    const uris = (e.dataTransfer.getData("application/vnd.code.uri-list") || e.dataTransfer.getData("text/uri-list"))
      .split(/\r?\n/)
      .filter((u) => u.startsWith("file:"));
    if (uris.length) {
      e.preventDefault();
      const root = prefs?.root;
      const refs = uris.map((u) => {
        const p = decodeURIComponent(new URL(u).pathname);
        return `@${escapePath(root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p)}`;
      });
      setText((cur) => (cur && !/\s$/.test(cur) ? cur + " " : cur) + refs.join(" ") + " ");
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      void addImages([...e.dataTransfer.files]).then((handled) => !handled && setHint("Drop files from the Explorer (hold Shift) to attach them."));
    }
  };

  if (readOnly)
    return (
      <div className="composer-wrap">
        <div className="readonly-note"><Icon name="eye" /> Worker transcript. Its report goes to the lead.</div>
      </div>
    );

  const ctx = state.context;
  const ctxLabel = ctx.file ? `${ctx.file.split("/").pop()}${ctx.selection ? `:${ctx.selection.start}-${ctx.selection.end}` : ""}` : undefined;
  const shell = /^!/.test(text);
  const lastUser = [...props.messages].reverse().find((m) => m.kind === "user");

  return (
    <div className="composer-wrap">
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((p) => (
            <div key={p.id} className="pending-row">
              <Icon name={p.delivery === "steer" ? "debug-step-into" : "clock"} className="dim" />
              <span className="grow ellipsis" title={p.text}>{p.text}</span>
              {p.delivery === "queue" && (
                <button className="ghost label" title="Send it into the running turn at its next step" onClick={() => post({ type: "pending", id: p.id, action: "steer" })}>Steer now</button>
              )}
              <button className="ghost" title="Remove from the queue" onClick={() => post({ type: "pending", id: p.id, action: "cancel" })}><Icon name="close" /></button>
            </div>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="menu slash-menu" role="listbox">
          {suggestions.map((sg, n) => (
            <div key={sg.key} role="option" aria-selected={n === sel} className={`menu-item ${n === sel ? "on" : ""}`} onMouseEnter={() => setSel(n)} onMouseDown={(e) => (e.preventDefault(), accept(sg))}>
              <Icon name={sg.icon} className="dim" />
              <span className="cmd">{sg.label}</span>
              <span className="menu-detail grow ellipsis">{sg.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer ${shell ? "shell" : ""}`}
        onClick={() => area.current?.focus()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {(images.length > 0 || (prefs?.attachActiveEditor && ctxLabel) || shell) && (
          <div className="chips">
            {shell && (
              <span className="chip mode" title="Runs in the workspace with no model turn; its output goes to the model with your next message">
                <Icon name="terminal" /> <span>Shell command</span>
              </span>
            )}
            {!shell && prefs?.attachActiveEditor && ctxLabel && (
              <button className={`chip ${attach ? "" : "off"}`} onClick={(e) => (e.stopPropagation(), setAttach(!attach))} title={attach ? `${ctx.file} is attached. Click to leave it out.` : "Not attached. Click to attach."}>
                <Icon name={attach ? "file-code" : "eye-closed"} />
                <span>{ctxLabel}</span>
              </button>
            )}
            {images.map((img, n) => (
              <span key={n} className="chip image" title={img.name}>
                <img src={img.dataUrl} alt="" />
                <span className="ellipsis">{img.name}</span>
                <button className="ghost" title="Remove" onClick={(e) => (e.stopPropagation(), setImages(images.filter((_, i) => i !== n)))}><Icon name="close" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label="Message Tellico"
          placeholder={busy ? "Queue a follow-up · Ctrl+Enter to steer now" : "Ask Tellico to build, fix or explain…"}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing;
            if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSel((n) => (n + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !composing && suggestions.length) {
              e.preventDefault();
              accept(suggestions[sel]);
            } else if (e.key === "Escape" && suggestions.length) {
              e.preventDefault();
              setDismissed(menuKey);
            } else if (e.key === "Enter" && !e.shiftKey && !composing) {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) send(busy ? "steer" : undefined);
              else send(busy ? "queue" : undefined);
            } else if (e.key === "ArrowUp" && !text && lastUser?.kind === "user") {
              // Recall the last message, like a shell.
              e.preventDefault();
              setText(lastUser.text);
            } else if (e.key === "Escape" && busy) {
              post({ type: "interrupt" });
            }
          }}
        />
        {hint && <div className="composer-hint"><Icon name="info" /> {hint}</div>}
        <div className="composer-foot" onClick={(e) => e.stopPropagation()}>
          <button className="foot-btn" title="Attach files or folders (or type @)" onClick={() => post({ type: "pickFiles" })}><Icon name="add" /></button>
          <span className="divider" />
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
                label={prefs.connection === "gateway" ? "Gateway" : "SSH"}
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
          {busy && (
            <button className="send stop" onClick={() => post({ type: "interrupt" })} title="Stop (Esc)"><Icon name="debug-stop" /></button>
          )}
          {(!busy || text.trim()) && (
            <button
              className={`send ${busy ? "queue" : ""}`}
              onClick={() => send(busy ? "queue" : undefined)}
              disabled={!text.trim()}
              title={busy ? "Queue for after this turn (Enter) · Ctrl+Enter steers it now" : shell ? "Run (Enter)" : "Send (Enter)"}
            >
              <Icon name={busy ? "clock" : shell ? "play" : "arrow-up"} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
