// Ways into the chat from the rest of VS Code: a "Fix with Tellico" quick fix
// on problems, "Explain / Ask" on a selection, and sending terminal output.

import * as vscode from "vscode";

/** Lines of context either side of a problem, so the fix is not done blind. */
const CONTEXT_LINES = 6;
const MAX_TERMINAL = 16_000;

export class TellicoCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty];

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    if (doc.uri.scheme !== "file" || !vscode.workspace.getConfiguration("tellico").get<boolean>("codeActions", true)) return [];
    const out: vscode.CodeAction[] = [];
    const problems = ctx.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
    if (problems.length) {
      const fix = new vscode.CodeAction(problems.length > 1 ? `Fix ${problems.length} problems with Tellico` : "Fix with Tellico", vscode.CodeActionKind.QuickFix);
      fix.command = { command: "tellico.fixProblems", title: fix.title, arguments: [doc.uri, problems] };
      out.push(fix);
    }
    if (!range.isEmpty) {
      const explain = new vscode.CodeAction("Explain with Tellico", vscode.CodeActionKind.Empty);
      explain.command = { command: "tellico.explainSelection", title: explain.title };
      out.push(explain);
    }
    return out;
  }
}

function ref(uri: vscode.Uri, start: number, end: number): string {
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/ /g, "\\ ");
  return `@${rel}#L${start}${end !== start ? `-${end}` : ""}`;
}

/** The prompt for one or more problems in a file, each with surrounding lines. */
export function fixPrompt(uri: vscode.Uri, problems: readonly vscode.Diagnostic[], lineCount: number): string {
  const first = Math.max(1, Math.min(...problems.map((d) => d.range.start.line + 1)) - CONTEXT_LINES);
  const last = Math.min(lineCount, Math.max(...problems.map((d) => d.range.end.line + 1)) + CONTEXT_LINES);
  const list = problems
    .map((d) => `- line ${d.range.start.line + 1}: ${d.message.split("\n")[0]}${d.source ? ` (${d.source}${d.code !== undefined ? ` ${typeof d.code === "object" ? d.code.value : d.code}` : ""})` : ""}`)
    .join("\n");
  return `Fix ${problems.length > 1 ? "these problems" : "this problem"} in ${ref(uri, first, last)}:\n${list}`;
}

export function explainPrompt(ed: vscode.TextEditor): string | undefined {
  if (ed.selection.isEmpty || ed.document.uri.scheme !== "file") return undefined;
  const s = ed.selection;
  const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
  return `Explain what ${ref(ed.document.uri, s.start.line + 1, end)} does and why.`;
}

/** Remembers the last command each terminal ran, via shell integration. */
export class TerminalWatcher implements vscode.Disposable {
  private readonly last = new WeakMap<vscode.Terminal, { command: string; output: string; exit?: number }>();
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    if (!vscode.window.onDidStartTerminalShellExecution) return;
    this.subs.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        let output = "";
        const entry = { command: e.execution.commandLine.value, output: "", exit: undefined as number | undefined };
        this.last.set(e.terminal, entry);
        for await (const chunk of e.execution.read()) {
          output = (output + chunk).slice(-MAX_TERMINAL);
          entry.output = output;
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const entry = this.last.get(e.terminal);
        if (entry) entry.exit = e.exitCode;
      }),
    );
  }

  lastCommand(t: vscode.Terminal | undefined) {
    return t ? this.last.get(t) : undefined;
  }

  dispose() {
    this.subs.forEach((d) => d.dispose());
  }
}

export function stripAnsi(s: string): string {
  // CSI and OSC sequences (shell integration emits OSC 633), then stray CRs.
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "");
}

export function terminalBlock(command: string | undefined, output: string, exit?: number): string {
  const body = stripAnsi(output).trimEnd();
  const clipped = body.length > MAX_TERMINAL ? "…\n" + body.slice(-MAX_TERMINAL) : body;
  return `\`\`\`console\n${command ? `$ ${command}\n` : ""}${clipped}\n\`\`\`${exit !== undefined && exit !== 0 ? `\n(exit code ${exit})` : ""}\n`;
}

/**
 * The terminal's selection, read through the clipboard (there is no stable
 * API) and the clipboard's text put back after. The commands only offer this
 * with text selected, so whatever the copy leaves is the selection.
 */
export async function terminalSelection(): Promise<string> {
  const saved = await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
  const text = await vscode.env.clipboard.readText();
  // An image or files on the clipboard read as "": nothing to restore.
  if (saved) await vscode.env.clipboard.writeText(saved);
  return text;
}
