// Small shared pieces: icons, the logo, formatting.

import React, { useEffect, useState } from "react";

/** Re-renders every `ms` while `active`, for elapsed-time labels. */
export function useTicker(active: boolean, ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

// ---------------- icons ----------------

export const Icon = ({ name, className = "" }: { name: string; className?: string }) => <i className={`codicon codicon-${name} ${className}`} aria-hidden />;

/** A "T" whose crossbar joins the two Tellico nodes. */
export function Logo({ size = 40 }: { size?: number }) {
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

export function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function relTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const DAY = 86_400_000;

/** A path relative to the workspace root, when it is inside it. */
export const rel = (p: string, root?: string) => (root && (p === root ? "." : p.startsWith(root + "/") ? p.slice(root.length + 1) : p)) || p;
