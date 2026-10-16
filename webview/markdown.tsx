// Markdown rendering, and the paced reveal of text that is still streaming.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { advance, safeCut } from "./smooth";
import { post } from "./host";

// ---------------- smooth streaming ----------------

export const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** Set from prefs; read by every paced block. */
let smoothEnabled = true;
export const setSmooth = (on: boolean) => void (smoothEnabled = on);

/**
 * Text revealed at a steady pace while `live`. A block that is complete when
 * it mounts (history, a reopened session) shows at once. One animation-frame
 * loop per streaming block, and only while it has a backlog to show.
 */
export function useSmoothText(text: string, live: boolean): string {
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
export function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text, live);
  if (!shown.trim()) return null;
  return <Markdown text={shown} />;
}

// ---------------- markdown ----------------

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const renderer = new Renderer();
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
export const md = new Marked({ gfm: true, breaks: false, renderer });

export const Markdown = memo(function Markdown({ text }: { text: string }) {
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
