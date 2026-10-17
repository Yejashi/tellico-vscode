// Adding MCP servers the way `opencode mcp add` does: into the user's own
// OpenCode config (the project's opencode.json, or the global one), which the
// running server watches and applies within seconds. The Tellico runtime
// config is never touched; servers named here sit below it in precedence.

import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultOptions, discover, Discovered, identity } from "./discover";
import {
  ConfigIssue,
  fixConfig,
  globalConfigCandidates,
  hostLabel,
  ImportResult,
  isHttpUrl,
  lintConfig,
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

  /** Every OpenCode config file that exists for this window: the project's, then the global ones. */
  configFiles(): { file: string; scope: Scope }[] {
    const project = this.root() ? projectConfigCandidates(this.root()!) : [];
    return [...project.map((file) => ({ file, scope: "project" as Scope })), ...globalConfigCandidates().map((file) => ({ file, scope: "global" as Scope }))].filter((f) => existsSync(f.file));
  }

  /** Servers already configured, by name and by command line or URL. */
  private configured(runtimeNames: string[]): { names: Set<string>; ids: Set<string> } {
    const names = new Set(runtimeNames);
    const ids = new Set<string>();
    for (const { file } of this.configFiles()) {
      try {
        for (const s of listServers(readFileSync(file, "utf8"))) {
          names.add(s.name);
          if (s.entry && typeof s.entry === "object") ids.add(identity(s.entry as any));
        }
      } catch {}
    }
    return { names, ids };
  }

  /** Entries OpenCode would misread, per config file. */
  lint(): { file: string; scope: Scope; issues: ConfigIssue[] }[] {
    const out: { file: string; scope: Scope; issues: ConfigIssue[] }[] = [];
    for (const f of this.configFiles()) {
      try {
        const issues = lintConfig(readFileSync(f.file, "utf8"));
        if (issues.length) out.push({ ...f, issues });
      } catch {}
    }
    return out;
  }

  /** Rewrites the flagged entries of one config file the way OpenCode reads them. */
  fix(file: string) {
    if (!this.configFiles().some((f) => f.file === file)) throw new Error(`${file} is not an OpenCode config file of this window.`);
    const text = readFileSync(file, "utf8");
    const next = fixConfig(text);
    if (next === text) return;
    writeFileSync(file, next);
    this.log(`MCP: fixed ${lintConfig(text).map((i) => i.name).join(", ")} in ${file}`);
  }

  /**
   * "Add server": what this machine already has (other clients' configs,
   * installed *-mcp commands, built MCP SDK packages), then the manual way.
   */
  async add(runtimeNames: string[] = [], searchPaths: string[] = []) {
    const configured = this.configured(runtimeNames);
    let found: Discovered[] = [];
    try {
      found = discover(defaultOptions(homedir(), this.root(), searchPaths.map((p) => p.replace(/^~(?=\/|$)/, homedir())))).filter((d) => !configured.ids.has(identity(d.entry)));
    } catch (err: any) {
      this.log(`MCP discovery failed: ${err?.message ?? err}`);
    }
    type Item = vscode.QuickPickItem & { found?: Discovered; manual?: "local" | "remote" };
    const items: Item[] = [];
    if (found.length) {
      items.push({ label: "Found on this system", kind: vscode.QuickPickItemKind.Separator });
      for (const d of found)
        items.push({
          label: `$(plug) ${d.name}`,
          description: summary(d.entry),
          detail: [d.source, d.envKeys.length ? `uses ${d.envKeys.join(", ")}` : "", configured.names.has(d.name) ? "a server with this name exists" : ""].filter(Boolean).join(" · "),
          found: d,
        });
      items.push({ label: "Enter it yourself", kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(
      { label: "$(terminal) Local command", detail: "A program OpenCode starts, e.g. npx -y @modelcontextprotocol/server-github", manual: "local" },
      { label: "$(cloud) Remote URL", detail: "A Streamable HTTP or SSE endpoint, e.g. https://mcp.example.com/mcp", manual: "remote" },
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: "Add MCP server",
      placeHolder: found.length ? `${found.length} found on this system, or enter one yourself` : COST_NOTE,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.found) return this.addFound(pick.found, configured.names);
    return this.addManual(pick.manual!);
  }

  /** Asks whether a new server starts now or waits until it is switched on. */
  private async pickStart(): Promise<boolean | undefined> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(play) Start it now", detail: "Its tools are available to the agents right away.", off: false },
        { label: "$(circle-slash) Add it switched off", detail: 'Written with "disabled": true. Switch it on in the Tools panel when you need it.', off: true },
      ],
      { title: "When should it run?", placeHolder: COST_NOTE },
    );
    return pick?.off;
  }

  private async addFound(d: Discovered, taken: Set<string>) {
    let suggested = d.name;
    for (let n = 2; taken.has(suggested); n++) suggested = `${d.name}-${n}`;
    const name = await vscode.window.showInputBox({
      title: `Add ${d.name} (from ${d.source})`,
      prompt: "Its tools are called <name>_<tool>",
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (v) => (!/^[A-Za-z0-9_-]+$/.test(v) ? "Letters, digits, - and _ only" : taken.has(v) ? "A server with this name is already configured" : undefined),
    });
    if (!name) return;
    const scope = await this.pickScope();
    if (!scope) return;
    let entry: McpServerEntry = d.entry;
    if (d.secrets) {
      const keys = Object.keys(d.secrets);
      const options: (vscode.QuickPickItem & { copy: boolean })[] = [
        { label: `$(link) Refer to ${keys.join(", ")} in your environment`, detail: `Writes {env:${keys[0]}}; export the variable in your shell profile so OpenCode sees it. Nothing secret goes in the file.`, copy: false },
      ];
      // A project file may be committed: never copy secrets into it.
      if (scope === "global") options.push({ label: `$(copy) Copy the value${keys.length > 1 ? "s" : ""} into ${this.configFile("global")}`, detail: `Plain text, as in ${d.source}'s own config.`, copy: true });
      const how = await vscode.window.showQuickPick(options, { title: `${d.name} uses ${keys.join(", ")}` });
      if (!how) return;
      if (how.copy) entry = withSecrets(entry, d.secrets);
    }
    const off = await this.pickStart();
    if (off === undefined) return;
    const file = this.write(scope, [{ name, entry: off ? { ...entry, disabled: true } : entry }]);
    void vscode.window
      .showInformationMessage(`Added "${name}" to ${file}${off ? ", switched off" : ""}. Tellico picks it up in a few seconds.`, "Open File")
      .then((p) => p && this.open(file));
  }

  private async addManual(kindValue: "local" | "remote") {
    const kind = { value: kindValue };
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
    const off = await this.pickStart();
    if (off === undefined) return;
    const entry: McpServerEntry = kind.value === "local" ? { type: "local", command: splitCommand(target) } : { type: "remote", url: target.trim() };
    const file = this.write(scope, [{ name, entry: off ? { ...entry, disabled: true } : entry }]);
    void vscode.window.showInformationMessage(`Added MCP server "${name}" to ${file}${off ? ", switched off" : ""}. Tellico picks it up in a few seconds.`, "Open File").then((p) => p && this.open(file));
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

/** One line for the picker: the command line or URL, with the home folder as ~. */
function summary(e: McpServerEntry): string {
  const text = e.type === "remote" ? e.url : e.command.join(" ");
  const home = homedir();
  return text.split(home + "/").join("~/");
}

/** The entry with its {env:NAME} references replaced by the literal values. */
function withSecrets(e: McpServerEntry, secrets: Record<string, string>): McpServerEntry {
  if (e.type === "local") return { ...e, environment: { ...(e.environment ?? {}), ...secrets } };
  return { ...e, headers: { ...(e.headers ?? {}), ...secrets } };
}
