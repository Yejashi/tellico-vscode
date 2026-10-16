// The tools the IDE MCP server offers the agent. Deliberately few, with short
// descriptions: every schema is resent with every request, and the local
// model's context is 131k. Output is plain text with workspace-relative paths.

import * as path from "path";
import * as vscode from "vscode";
import { IdeTool } from "./mcpServer";

const MAX_DIAGNOSTICS = 200;
const MAX_SELECTION_BYTES = 16 * 1024;
/** How long to wait for a language server to report on a file we just opened for it. */
const OPEN_WAIT_MS = 2000;

export function ideTools(root: () => string | undefined): IdeTool[] {
  const rel = (uri: vscode.Uri) => relativePath(uri, root());
  return [
    {
      name: "diagnostics",
      description:
        "Compiler and linter problems VS Code currently reports, from its language servers. Use after editing to check for errors.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory; omit for the whole workspace." },
          severity: { type: "string", enum: ["error", "warning", "all"], description: "Minimum severity (default warning)." },
        },
        additionalProperties: false,
      },
      call: (args) => diagnostics(args, root, rel),
    },
    {
      name: "open_editors",
      description: "Files open in VS Code: the active one with its selection, and which have unsaved changes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => ({ text: openEditors(rel) }),
    },
    {
      name: "selection",
      description: "The text the user has selected in the active editor (or the line under the cursor), with its file and lines.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => ({ text: selection(rel) }),
    },
  ];
}

async function diagnostics(
  args: Record<string, unknown>,
  root: () => string | undefined,
  rel: (uri: vscode.Uri) => string,
): Promise<{ text: string; isError?: boolean }> {
  const severity = args.severity ?? "warning";
  if (severity !== "error" && severity !== "warning" && severity !== "all") {
    return { text: `severity must be error, warning or all`, isError: true };
  }
  const max = severity === "error" ? vscode.DiagnosticSeverity.Error : severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint;

  let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
  let scope = "the workspace";
  if (args.path !== undefined) {
    if (typeof args.path !== "string" || !args.path) return { text: "path must be a non-empty string", isError: true };
    const base = root();
    if (!path.isAbsolute(args.path) && !base) return { text: "No workspace folder to resolve a relative path against", isError: true };
    const uri = vscode.Uri.file(path.resolve(base ?? "/", args.path));
    scope = rel(uri);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return { text: `No such file or directory: ${scope}`, isError: true };
    }
    if (stat.type & vscode.FileType.Directory) {
      const prefix = uri.fsPath.endsWith(path.sep) ? uri.fsPath : uri.fsPath + path.sep;
      entries = vscode.languages.getDiagnostics().filter(([u]) => u.scheme === "file" && u.fsPath.startsWith(prefix));
    } else {
      await ensureAnalyzed(uri);
      entries = [[uri, vscode.languages.getDiagnostics(uri)]];
    }
  } else {
    entries = vscode.languages.getDiagnostics().filter(([u]) => u.scheme === "file" || u.scheme === "untitled");
  }

  const rows: { sev: number; file: string; line: number; col: number; text: string }[] = [];
  for (const [uri, diags] of entries) {
    const file = rel(uri);
    for (const d of diags) {
      if (d.severity > max) continue;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const source = d.source ? ` [${d.source}]` : "";
      const message = d.message.replace(/\s*\n\s*/g, " ");
      rows.push({ sev: d.severity, file, line, col, text: `${file}:${line}:${col} ${SEVERITY[d.severity]}${source} ${message}` });
    }
  }
  if (!rows.length) {
    const what = severity === "error" ? "errors" : severity === "warning" ? "errors or warnings" : "problems";
    return { text: `No ${what} reported for ${scope}.` };
  }
  rows.sort((a, b) => a.sev - b.sev || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  const lines = rows.slice(0, MAX_DIAGNOSTICS).map((r) => r.text);
  if (rows.length > MAX_DIAGNOSTICS) lines.push(`… ${rows.length - MAX_DIAGNOSTICS} more`);
  return { text: lines.join("\n") };
}

const SEVERITY: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

/**
 * Language servers mostly only check open documents. Opening one (without
 * showing it) makes them look; give them a moment to report.
 */
async function ensureAnalyzed(uri: vscode.Uri): Promise<void> {
  if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) return;
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch {
    return; // binary or unreadable: report whatever there is
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    };
    const timer = setTimeout(done, OPEN_WAIT_MS);
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === uri.toString())) done();
    });
  });
}

function openEditors(rel: (uri: vscode.Uri) => string): string {
  const active = vscode.window.activeTextEditor;
  const visible = new Set(vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()));
  const seen = new Map<string, { uri: vscode.Uri; dirty: boolean }>();
  const add = (uri: vscode.Uri, dirty: boolean) => {
    const key = uri.toString();
    const prev = seen.get(key);
    seen.set(key, { uri, dirty: dirty || !!prev?.dirty });
  };
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) add(tab.input.uri, tab.isDirty);
      else if (tab.input instanceof vscode.TabInputTextDiff) add(tab.input.modified, tab.isDirty);
    }
  }
  if (active) add(active.document.uri, active.document.isDirty);
  if (!seen.size) return "No files are open.";

  const lines: string[] = [];
  for (const [key, { uri, dirty }] of seen) {
    const marks: string[] = [];
    if (active && active.document.uri.toString() === key) {
      marks.push("active");
      const s = active.selection;
      marks.push(s.isEmpty ? `cursor ${s.active.line + 1}:${s.active.character + 1}` : `selected ${lineRange(s)}`);
    } else if (visible.has(key)) {
      marks.push("visible");
    }
    if (dirty) marks.push("unsaved");
    lines.push(marks.length ? `${rel(uri)} (${marks.join(", ")})` : rel(uri));
  }
  return lines.join("\n");
}

function selection(rel: (uri: vscode.Uri) => string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "No active text editor.";
  const doc = editor.document;
  const s = editor.selection;
  let header: string;
  let text: string;
  if (s.isEmpty) {
    const line = s.active.line + 1;
    header = `${rel(doc.uri)}:${line} (no selection; the line under the cursor)`;
    text = doc.lineAt(s.active.line).text;
  } else {
    header = `${rel(doc.uri)}:${lineRange(s)}`;
    text = doc.getText(s);
  }
  if (doc.isDirty) header += " (unsaved changes)";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_SELECTION_BYTES) {
    const cut = bytes.subarray(0, MAX_SELECTION_BYTES).toString("utf8").replace(/�+$/, "");
    return `${header}\n${cut}\n… truncated: showing ${MAX_SELECTION_BYTES / 1024} KB of ${Math.ceil(bytes.length / 1024)} KB; read the file for the rest.`;
  }
  return `${header}\n${text}`;
}

/** 1-based "start-end" lines; a selection ending at column 0 doesn't include that line. */
function lineRange(s: vscode.Selection): string {
  const start = s.start.line + 1;
  let end = s.end.line + 1;
  if (s.end.character === 0 && s.end.line > s.start.line) end--;
  return start === end ? `${start}` : `${start}-${end}`;
}

function relativePath(uri: vscode.Uri, root: string | undefined): string {
  if (uri.scheme !== "file") return uri.scheme === "untitled" ? `${uri.path} (untitled)` : uri.toString(true);
  if (root) {
    const r = path.relative(root, uri.fsPath);
    if (r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)) return r.split(path.sep).join("/");
    if (!r) return ".";
  }
  return uri.fsPath;
}
