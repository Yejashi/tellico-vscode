// Rebuilds a file's original text from its current text and the unified
// patch OpenCode reports for it (GET /api/session/{id}/diff), so VS Code's own
// diff editor can show before/after and "revert" can restore the original.

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line === "" ) continue;
    if (line[0] === " " || line[0] === "+" || line[0] === "-") cur.lines.push(line);
  }
  return hunks;
}

/**
 * Applies `patch` in reverse to `current`. Returns undefined when the file
 * no longer matches what the patch describes (edited again since), so the
 * caller can say so instead of showing a wrong diff.
 */
export function reversePatch(current: string, patch: string): string | undefined {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const hunks = parseHunks(patch);
  // Work bottom-up so earlier line numbers stay valid.
  for (const h of [...hunks].reverse()) {
    const after = h.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const before = h.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const start = Math.max(0, after.length === 0 ? h.newStart : h.newStart - 1);
    const slice = lines.slice(start, start + after.length);
    if (slice.length !== after.length || slice.some((l, i) => l !== after[i])) return undefined;
    lines.splice(start, after.length, ...before);
  }
  return lines.join(eol);
}
