// Adding MCP servers the way `opencode mcp add` does: into the user's own
// OpenCode config (the project's opencode.json, or the global one), which the
// running server watches and applies within seconds. The Tellico runtime
// config is never touched; servers named here sit below it in precedence.

import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  globalConfigCandidates,
  hostLabel,
  ImportResult,
  isHttpUrl,
  listServers,
  McpServerEntry,
  parseVsCodeMcp,
  projectConfigCandidates,
  sanitizeName,
  splitCommand,
  upsertServer,
  vscodeUserMcpPaths,
} from "./config";

type Scope = "project" | "global";

/** Every tool a server offers is described to the model on every request. */
const COST_NOTE =
  "Each MCP tool's description is sent with every request, against Tellico's 131k-token context, and Tellico's secret-guard does not inspect MCP tools. Add only servers you need.";

export class McpManager {
  constructor(private readonly root: () => string | undefined, private readonly log: (line: string) => void) {}

  /** The file a scope writes to: the first that exists, else opencode.json. */
  configFile(scope: Scope): string | undefined {
    const candidates = scope === "project" ? (this.root() ? projectConfigCandidates(this.root()!) : []) : globalConfigCandidates();
    return candidates.find(existsSync) ?? candidates[0];
  }

  private async pickScope(): Promise<Scope | undefined> {
    const items: (vscode.QuickPickItem & { scope: Scope })[] = [
      { scope: "project", label: "$(folder) This project", description: this.configFile("project"), detail: "Only sessions in this folder. Commit it to share with your team." },
      { scope: "global", label: "$(globe) All projects", description: this.configFile("global"), detail: "Every OpenCode session on this device, Tellico or not." },
    ];
    if (!this.root()) items.shift();
    return (await vscode.window.showQuickPick(items, { title: "Add the MCP server to…" }))?.scope;
  }

  private write(scope: Scope, servers: { name: string; entry: McpServerEntry }[]) {
    const file = this.configFile(scope);
    if (!file) throw new Error("Open a folder first.");
    let text = existsSync(file) ? readFileSync(file, "utf8") : "";
    for (const s of servers) text = upsertServer(text, s.name, s.entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    this.log(`MCP: wrote ${servers.map((s) => s.name).join(", ")} to ${file}`);
    return file;
  }

  async add() {
    const kind = await vscode.window.showQuickPick(
      [
        { label: "$(terminal) Local command", detail: "A program OpenCode starts, e.g. npx -y @modelcontextprotocol/server-github", value: "local" as const },
        { label: "$(cloud) Remote URL", detail: "A Streamable HTTP or SSE endpoint, e.g. https://mcp.example.com/mcp", value: "remote" as const },
      ],
      { title: "Add MCP server", placeHolder: COST_NOTE },
    );
    if (!kind) return;
    const target = await vscode.window.showInputBox({
      title: kind.value === "local" ? "Command line" : "Server URL",
      prompt: kind.value === "local" ? "Use {env:NAME} for secrets so they stay out of the file" : "OAuth sign-in, if the server needs it, starts from the MCP panel",
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? "Required" : kind.value === "remote" && !isHttpUrl(v.trim()) ? "Enter an http(s) URL" : undefined),
    });
    if (!target) return;
    const suggested = kind.value === "remote" ? hostLabel(target.trim()) : (splitCommand(target).find((a) => !a.startsWith("-") && !/^(npx|uvx|node|python3?|bunx|docker|run)$/.test(a)) ?? "server");
    const name = await vscode.window.showInputBox({
      title: "Server name",
      prompt: "Its tools are called <name>_<tool>",
      value: sanitizeName(suggested.replace(/^@[^/]+\//, "").replace(/^(mcp-)?server-|-mcp$/g, "")),
      ignoreFocusOut: true,
      validateInput: (v) => (/^[A-Za-z0-9_-]+$/.test(v) ? undefined : "Letters, digits, - and _ only"),
    });
    if (!name) return;
    const scope = await this.pickScope();
    if (!scope) return;
    const entry: McpServerEntry = kind.value === "local" ? { type: "local", command: splitCommand(target) } : { type: "remote", url: target.trim() };
    const file = this.write(scope, [{ name, entry }]);
    void vscode.window.showInformationMessage(`Added MCP server "${name}" to ${file}. Tellico picks it up in a few seconds.`, "Open File").then((p) => p && this.open(file));
  }

  /** Copies servers from VS Code's own mcp.json files into OpenCode's config. */
  async importFromVsCode() {
    const sources = [...(this.root() ? [join(this.root()!, ".vscode", "mcp.json")] : []), ...vscodeUserMcpPaths()].filter(existsSync);
    if (!sources.length) {
      void vscode.window.showInformationMessage("No VS Code MCP configuration found (.vscode/mcp.json or your user mcp.json).");
      return;
    }
    // ${env:X} becomes OpenCode's own {env:X}, so tokens stay in the
    // environment instead of being copied into opencode.json.
    const env = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `{env:${k}}` : undefined), has: () => true }) as Record<string, string>;
    const found: (ImportResult & { source: string })[] = [];
    for (const source of sources) {
      try {
        for (const r of parseVsCodeMcp(readFileSync(source, "utf8"), { workspaceFolder: this.root(), userHome: homedir(), env })) found.push({ ...r, source });
      } catch (err: any) {
        this.log(`MCP import: ${source}: ${err?.message ?? err}`);
      }
    }
    if (!found.length) {
      void vscode.window.showInformationMessage("The VS Code MCP configuration has no servers.");
      return;
    }
    const picks = await vscode.window.showQuickPick(
      found.map((r) => ({
        label: `${r.entry ? "" : "$(warning) "}${r.name}`,
        description: r.entry ? (r.entry.type === "local" ? r.entry.command.join(" ") : r.entry.url) : "cannot import",
        detail: r.problems.length ? r.problems.join(" ") : r.source,
        picked: Boolean(r.entry) && !r.problems.length,
        r,
      })),
      { title: "Import MCP servers from VS Code", canPickMany: true, placeHolder: COST_NOTE },
    );
    const chosen = (picks ?? []).map((p) => p.r).filter((r): r is ImportResult & { source: string; entry: McpServerEntry } => Boolean(r.entry));
    if (!chosen.length) return;
    const scope = await this.pickScope();
    if (!scope) return;
    const target = this.configFile(scope);
    const existing = new Set(target && existsSync(target) ? listServers(readFileSync(target, "utf8")).map((x) => x.name) : []);
    const clash = chosen.filter((r) => existing.has(r.name)).map((r) => r.name);
    if (clash.length) {
      const pick = await vscode.window.showWarningMessage(
        `${clash.join(", ")} ${clash.length > 1 ? "are" : "is"} already in ${target}.`,
        { modal: true },
        "Replace",
        "Skip Those",
      );
      if (!pick) return;
      if (pick === "Skip Those") chosen.splice(0, chosen.length, ...chosen.filter((r) => !existing.has(r.name)));
      if (!chosen.length) return;
    }
    const file = this.write(scope, chosen.map((r) => ({ name: r.name, entry: r.entry })));
    const problems = chosen.filter((r) => r.problems.length).map((r) => r.name);
    void vscode.window
      .showInformationMessage(
        `Imported ${chosen.length} MCP server${chosen.length > 1 ? "s" : ""} into ${file}.${problems.length ? ` Check ${problems.join(", ")}: some values could not be carried over.` : ""}`,
        "Open File",
      )
      .then((p) => p && this.open(file));
  }

  async openConfig() {
    const scope = await this.pickScope();
    if (!scope) return;
    const file = this.configFile(scope)!;
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "servers": {}\n  }\n}\n`);
    }
    await this.open(file);
  }

  private async open(file: string) {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }
}
