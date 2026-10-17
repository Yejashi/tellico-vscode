// Finds MCP servers already on this machine, so "Add server" can offer them:
//
// - other clients' configs: Claude Code, Claude Desktop, Cursor, VS Code,
//   Windsurf, Cline, Roo, Gemini CLI, Codex, Crush, Zed
// - installed commands named like an MCP server (`libgen-mcp`, `mcp-foo`)
// - local Node packages built on the MCP SDK with a bin (your own servers,
//   e.g. an mcp-servers monorepo), under a few search roots
//
// No vscode import, so it is unit-tested against a fake home directory.

import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { McpServerEntry, parseVsCodeMcp, sanitizeName } from "./config";

export interface Discovered {
  name: string;
  entry: McpServerEntry;
  /** Where it was found, for the picker: "Claude Code", "installed command", "~/repos/x". */
  source: string;
  /** Environment variables (local) or headers (remote) the entry carries. */
  envKeys: string[];
  /**
   * Their literal values, kept out of `entry`, which refers to them as
   * {env:NAME}: they are copied into a config only if the user says so.
   */
  secrets?: Record<string, string>;
}

export interface DiscoverOptions {
  home: string;
  /** The open workspace folder, for project-level configs. */
  root?: string;
  /** Directories searched for installed commands (PATH plus ~/.local/bin). */
  pathDirs: string[];
  /** Directories searched (a few levels deep) for MCP SDK packages. */
  searchRoots: string[];
  /** Absolute node, for running a package's bin. */
  node: string;
  platform?: NodeJS.Platform;
  xdgConfig?: string;
}

/** Defaults from the real environment. */
export function defaultOptions(home: string, root: string | undefined, extraRoots: string[] = []): DiscoverOptions {
  const pathDirs = [...(process.env.PATH ?? "").split(delimiter), join(home, ".local", "bin")].filter(Boolean);
  const node = pathDirs.map((d) => join(d, "node")).find(isExecutable) ?? process.execPath;
  const roots = [...extraRoots, ...["Documents/repos", "repos", "code", "src", "projects", "dev"].map((d) => join(home, d))];
  return { home, root, pathDirs, searchRoots: [...new Set(roots)].filter((d) => existsSync(d)), node, platform: process.platform, xdgConfig: process.env.XDG_CONFIG_HOME };
}

export function discover(opts: DiscoverOptions): Discovered[] {
  const found: Discovered[] = [];
  const add = (d: Discovered[]) => found.push(...d);
  for (const c of clientConfigs(opts)) add(fromClientFile(c.path, c.label, c.kind, opts));
  add(fromCommands(opts));
  add(fromPackages(opts));
  // One entry per distinct command line or URL: the first source wins.
  const seen = new Set<string>();
  return found.filter((d) => {
    const key = identity(d.entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What makes two entries the same server: the command line or the URL. */
export function identity(e: McpServerEntry | Record<string, unknown>): string {
  const x = e as any;
  if (x.type === "remote" || x.url) return `url:${x.url}`;
  const cmd = Array.isArray(x.command) ? x.command : [x.command, ...(x.args ?? [])];
  return `cmd:${cmd.filter(Boolean).join(" ")}`;
}

// ---------- other clients ----------

type Kind = "mcpServers" | "vscode" | "claude-code" | "codex" | "crush" | "zed";

function clientConfigs(o: DiscoverOptions): { path: string; label: string; kind: Kind }[] {
  const h = o.home;
  const cfg = o.xdgConfig || join(h, ".config");
  const mac = o.platform === "darwin";
  const appData = (...p: string[]) => (mac ? join(h, "Library", "Application Support", ...p) : join(cfg, ...p));
  const vscodeUser = (product: string) => appData(product, "User");
  const list: { path: string; label: string; kind: Kind }[] = [
    { path: join(h, ".claude.json"), label: "Claude Code", kind: "claude-code" },
    { path: appData("Claude", "claude_desktop_config.json"), label: "Claude Desktop", kind: "mcpServers" },
    { path: join(h, ".cursor", "mcp.json"), label: "Cursor", kind: "mcpServers" },
    { path: join(h, ".codeium", "windsurf", "mcp_config.json"), label: "Windsurf", kind: "mcpServers" },
    { path: join(h, ".gemini", "settings.json"), label: "Gemini CLI", kind: "mcpServers" },
    { path: join(h, ".codex", "config.toml"), label: "Codex", kind: "codex" },
    { path: join(cfg, "crush", "crush.json"), label: "Crush", kind: "crush" },
    { path: join(cfg, "zed", "settings.json"), label: "Zed", kind: "zed" },
  ];
  for (const product of ["Code", "Code - Insiders", "VSCodium", "Cursor"]) {
    list.push({ path: join(vscodeUser(product), "mcp.json"), label: `${product} (user)`, kind: "vscode" });
    const gs = join(vscodeUser(product), "globalStorage");
    list.push({ path: join(gs, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), label: "Cline", kind: "mcpServers" });
    list.push({ path: join(gs, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"), label: "Roo Code", kind: "mcpServers" });
    list.push({ path: join(gs, "kilocode.kilo-code", "settings", "mcp_settings.json"), label: "Kilo Code", kind: "mcpServers" });
  }
  if (o.root) {
    list.push({ path: join(o.root, ".vscode", "mcp.json"), label: "this workspace (.vscode/mcp.json)", kind: "vscode" });
    list.push({ path: join(o.root, ".mcp.json"), label: "this workspace (.mcp.json)", kind: "mcpServers" });
    list.push({ path: join(o.root, ".cursor", "mcp.json"), label: "this workspace (Cursor)", kind: "mcpServers" });
  }
  return list;
}

function fromClientFile(path: string, label: string, kind: Kind, o: DiscoverOptions): Discovered[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    if (kind === "codex") return toDiscovered(codexServers(text), label, o);
    const json = parseLoose(text);
    if (kind === "claude-code") {
      const out = toDiscovered(json?.mcpServers ?? {}, label, o);
      for (const [dir, p] of Object.entries<any>(json?.projects ?? {}))
        if (p?.mcpServers && Object.keys(p.mcpServers).length) out.push(...toDiscovered(p.mcpServers, `Claude Code (${tilde(dir, o.home)})`, o));
      return out;
    }
    if (kind === "crush") return toDiscovered(json?.mcp ?? {}, label, o);
    if (kind === "zed") {
      // Zed: { context_servers: { name: { command: { path, args, env } } | { command, args, env } } }
      const servers: Record<string, unknown> = {};
      for (const [n, v] of Object.entries<any>(json?.context_servers ?? {})) {
        const c = v?.command;
        servers[n] = c && typeof c === "object" ? { command: c.path, args: c.args, env: c.env } : v;
      }
      return toDiscovered(servers, label, o);
    }
    if (kind === "vscode") return toDiscovered(json?.servers ?? {}, label, o, text);
    return toDiscovered(json?.mcpServers ?? {}, label, o);
  } catch {
    return [];
  }
}

/** Translates a { name: definition } map with the same rules as the VS Code import. */
function toDiscovered(servers: Record<string, unknown>, source: string, o: DiscoverOptions, raw?: string): Discovered[] {
  if (!servers || typeof servers !== "object" || !Object.keys(servers).length) return [];
  // ${env:X} stays a reference ({env:X}), never the value.
  const env = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `{env:${k}}` : undefined), has: () => true }) as Record<string, string>;
  const text = raw ?? JSON.stringify({ servers });
  return parseVsCodeMcp(text, { userHome: o.home, workspaceFolder: o.root, env })
    .filter((r) => r.entry && !(servers as any)[r.originalName ?? r.name]?.disabled)
    .map((r) => withReferences({ name: r.name, entry: r.entry!, source, envKeys: [] }));
}

/** Moves literal environment values out of the entry, leaving {env:NAME} in their place. */
function withReferences(d: Discovered): Discovered {
  const e = d.entry as any;
  const field = e.type === "local" ? "environment" : "headers";
  const map: Record<string, string> = e[field] ?? {};
  const secrets: Record<string, string> = {};
  const refs: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (/^\{env:[^}]+\}$/.test(v)) refs[k] = v;
    else {
      secrets[k] = v;
      refs[k] = field === "environment" ? `{env:${k}}` : v.replace(/[^\s]+$/, `{env:${k.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}}`);
    }
  }
  return { ...d, entry: Object.keys(map).length ? ({ ...e, [field]: refs } as McpServerEntry) : d.entry, envKeys: Object.keys(map), ...(Object.keys(secrets).length ? { secrets } : {}) };
}

/**
 * The [mcp_servers.<name>] tables of a Codex config.toml: command, args,
 * env (inline or as a [mcp_servers.<name>.env] table) and url. A small TOML
 * subset, which is all Codex writes there.
 */
export function codexServers(toml: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> {
  const out: Record<string, any> = {};
  let current: { name: string; env: boolean } | undefined;
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const table = /^\[\s*mcp_servers\.("?)([^".\]]+)\1(\.env)?\s*\]$/.exec(line);
    if (table) {
      current = { name: table[2], env: Boolean(table[3]) };
      out[current.name] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const kv = /^("?)([A-Za-z0-9_-]+)\1\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[3];
    // An array may run over several lines.
    while (value.startsWith("[") && !balanced(value) && i + 1 < lines.length) value += " " + lines[++i].trim();
    const parsed = tomlValue(value);
    const entry = out[current.name];
    if (current.env) (entry.env ??= {})[kv[2]] = String(parsed);
    else entry[kv[2]] = parsed;
  }
  return out;
}

function balanced(s: string): boolean {
  let depth = 0;
  let q: string | undefined;
  for (const c of s) {
    if (q) {
      if (c === q) q = undefined;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth === 0;
}

function tomlValue(v: string): unknown {
  v = v.replace(/\s+#.*$/, "").trim();
  if (v.startsWith('"')) return JSON.parse(v.slice(0, v.lastIndexOf('"') + 1));
  if (v.startsWith("'")) return v.slice(1, v.indexOf("'", 1));
  if (v.startsWith("[")) {
    const items: unknown[] = [];
    for (const m of v.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) items.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
    return items;
  }
  if (v.startsWith("{")) {
    const o: Record<string, unknown> = {};
    for (const m of v.slice(1, -1).matchAll(/("?)([A-Za-z0-9_-]+)\1\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}]+)/g)) o[m[2]] = tomlValue(m[3]);
    return o;
  }
  if (v === "true" || v === "false") return v === "true";
  return Number.isFinite(Number(v)) ? Number(v) : v;
}

// ---------- installed commands ----------

const COMMAND_NAME = /^(mcp[-_].+|.+[-_]mcp(-server)?|mcp-server-.+)$/i;
/** Development tools and clients, not servers. */
const NOT_SERVERS = /^(mcp-(inspector|cli|proxy|remote|hub|get|publisher)|mcp)$/i;

export function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromCommands(o: DiscoverOptions): Discovered[] {
  const out: Discovered[] = [];
  const seen = new Set<string>();
  for (const dir of o.pathDirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (!COMMAND_NAME.test(f) || NOT_SERVERS.test(f) || seen.has(f) || /\.(md|txt|json|cmd|ps1)$/i.test(f)) continue;
      const p = join(dir, f);
      if (!isExecutable(p)) continue;
      seen.add(f);
      // Named as installed (libgen-mcp stays libgen-mcp).
      out.push({ name: sanitizeName(f), entry: { type: "local", command: [p] }, source: `installed command (${tilde(dir, o.home)})`, envKeys: [] });
    }
  }
  return out;
}

// ---------- local packages built on the MCP SDK ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", "target", "venv", ".venv", "templates"]);

function fromPackages(o: DiscoverOptions): Discovered[] {
  const out: Discovered[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("package.json")) {
      const d = mcpPackage(dir, o);
      if (d) out.push(d);
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) visit(p, depth - 1);
      } catch {}
    }
  };
  for (const r of o.searchRoots) visit(resolve(r), 3);
  return out;
}

function mcpPackage(dir: string, o: DiscoverOptions): Discovered | undefined {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  if (!deps["@modelcontextprotocol/sdk"] || !pkg.bin) return undefined;
  const bins: Record<string, string> = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin;
  const [binName, rel] = Object.entries(bins)[0] ?? [];
  if (!rel) return undefined;
  const file = resolve(dir, rel);
  // Only built servers: a bin that does not exist yet would fail to start.
  if (!existsSync(file)) return undefined;
  // The package's own name, without an npm scope.
  const name = sanitizeName(String(pkg.name ?? binName).replace(/^@[^/]+\//, "") || binName);
  return { name, entry: { type: "local", command: [o.node, file] }, source: tilde(dir, o.home), envKeys: [] };
}

function tilde(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** JSON with comments and trailing commas, as several clients write it. */
function parseLoose(text: string): any {
  const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}
