// MCP servers in the user's own OpenCode config files, and import from VS
// Code's mcp.json (or a pasted Claude Desktop / Cursor "mcpServers" block).
//
// Pure text-in/text-out: no vscode, no fs. Edits go through jsonc-parser so
// comments and formatting in a hand-written opencode.json(c) survive, the same
// way `opencode mcp add` leaves the rest of the file alone. The server watches
// its config files, so a written file takes effect within seconds.

import * as os from "node:os";
import * as path from "node:path";
// The ESM build: the UMD entry ("main") requires its parts through a factory
// parameter, which esbuild cannot follow, so the bundle would fail at runtime.
import {
  applyEdits,
  findNodeAtLocation,
  format,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";

/** An OpenCode 2 `mcp.servers` entry, limited to what the extension writes. */
export type McpServerEntry =
  | { type: "local"; command: string[]; cwd?: string; environment?: Record<string, string>; disabled?: boolean }
  | { type: "remote"; url: string; headers?: Record<string, string>; disabled?: boolean };

export interface ImportResult {
  /** Sanitized server name, unique within one import. */
  name: string;
  /** The name as written in the source, when sanitizing changed it. */
  originalName?: string;
  /** Absent when the server could not be translated at all. */
  entry?: McpServerEntry;
  /** Human-readable notes on anything not carried over faithfully. */
  problems: string[];
}

export interface ImportVars {
  workspaceFolder?: string;
  userHome?: string;
  env?: Record<string, string | undefined>;
}

export const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

// ---------------------------------------------------------------------------
// Import

/**
 * Translates VS Code's `.vscode/mcp.json` (`servers`), or a Claude Desktop /
 * Cursor style `mcpServers` block, into OpenCode 2 entries. Throws when the
 * text is not JSON(C) or holds no server map.
 */
export function parseVsCodeMcp(text: string, vars: ImportVars): ImportResult[] {
  const root = parseJsonc(text);
  if (!isObject(root)) throw new Error("Expected a JSON object with \"servers\" or \"mcpServers\".");
  let servers: unknown;
  if (isObject(root.servers)) servers = root.servers;
  else if (isObject(root.mcpServers)) servers = root.mcpServers;
  else if (Object.keys(root).length && Object.values(root).every(looksLikeServer)) servers = root; // a bare map
  else throw new Error("No \"servers\" or \"mcpServers\" object found.");

  const used = new Set<string>();
  const out: ImportResult[] = [];
  for (const [raw, def] of Object.entries(servers as Record<string, unknown>)) {
    const name = uniqueName(sanitizeName(raw), used);
    const result = translate(def, vars);
    out.push({ name, ...(name !== raw ? { originalName: raw } : {}), ...result });
  }
  return out;
}

/** Server names OpenCode can use in tool ids: letters, digits, `-` and `_`. */
export function sanitizeName(name: string): string {
  const clean = name
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return clean || "server";
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name}-${i}`;
  used.add(candidate);
  return candidate;
}

function looksLikeServer(v: unknown): boolean {
  return isObject(v) && (typeof v.command === "string" || typeof v.url === "string");
}

function translate(def: unknown, vars: ImportVars): { entry?: McpServerEntry; problems: string[] } {
  const problems = new Set<string>();
  if (!isObject(def)) return { problems: ["not an object; skipped"] };
  const sub = (s: string) => substitute(s, vars, problems);
  const disabled = def.disabled === true || def.enabled === false ? { disabled: true } : {};

  const url = typeof def.url === "string" ? def.url : typeof def.serverUrl === "string" ? def.serverUrl : undefined;
  const rawType = typeof def.type === "string" ? def.type : typeof def.transport === "string" ? def.transport : undefined;
  const type = rawType ?? (typeof def.command === "string" ? "stdio" : url !== undefined ? "http" : undefined);

  if (type === "stdio") {
    if (typeof def.command !== "string" || !def.command) return { problems: ["stdio server without a \"command\"; skipped"] };
    const args = Array.isArray(def.args) ? def.args : [];
    if (args.some((a) => typeof a !== "string")) problems.add("non-string args were converted to strings");
    const command = [def.command, ...args.map(String)].map(sub);
    const environment = stringMap(def.env, "env", sub, problems);
    const cwd = typeof def.cwd === "string" ? sub(def.cwd) : undefined;
    if (def.envFile !== undefined) problems.add("envFile is not supported by OpenCode; variables from it are not imported");
    const entry: McpServerEntry = {
      type: "local",
      command,
      ...(cwd ? { cwd } : {}),
      ...(environment ? { environment } : {}),
      ...disabled,
    };
    return { entry, problems: [...problems] };
  }

  if (type === "http" || type === "sse" || type === "streamable-http" || type === "streamableHttp") {
    if (!url) return { problems: [`${type} server without a "url"; skipped`] };
    const headers = stringMap(def.headers, "headers", sub, problems);
    const entry: McpServerEntry = { type: "remote", url: sub(url), ...(headers ? { headers } : {}), ...disabled };
    return { entry, problems: [...problems] };
  }

  return { problems: [rawType ? `unsupported server type "${rawType}"; skipped` : "neither \"command\" nor \"url\"; skipped"] };
}

function stringMap(
  v: unknown,
  field: string,
  sub: (s: string) => string,
  problems: Set<string>,
): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) {
    problems.add(`"${field}" is not an object; ignored`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue;
    out[k] = sub(typeof val === "string" ? val : String(val));
  }
  return Object.keys(out).length ? out : undefined;
}

/** VS Code's `${…}` variables we can resolve; everything else is left verbatim and reported. */
function substitute(s: string, vars: ImportVars, problems: Set<string>): string {
  return s.replace(/\$\{([^}]*)\}/g, (whole, expr: string) => {
    if (expr === "workspaceFolder" || expr === "workspaceRoot") {
      if (vars.workspaceFolder !== undefined) return vars.workspaceFolder;
      problems.add(`uses \${${expr}}, but no workspace folder is open; set it in opencode.json by hand`);
      return whole;
    }
    if (expr === "workspaceFolderBasename" && vars.workspaceFolder !== undefined) return path.basename(vars.workspaceFolder);
    if (expr === "userHome") {
      if (vars.userHome !== undefined) return vars.userHome;
      problems.add("uses ${userHome}, which could not be resolved; set it in opencode.json by hand");
      return whole;
    }
    if (expr === "pathSeparator" || expr === "/") return path.sep;
    if (expr.startsWith("env:")) {
      const name = expr.slice(4);
      const value = vars.env?.[name];
      if (value !== undefined) return value;
      problems.add(`uses \${env:${name}}, which is not set here; set it in opencode.json by hand`);
      return whole;
    }
    if (expr.startsWith("input:")) {
      problems.add(`uses \${${expr}}, which only VS Code can prompt for; set it in opencode.json by hand`);
      return whole;
    }
    problems.add(`uses \${${expr}}, which cannot be resolved outside VS Code; set it in opencode.json by hand`);
    return whole;
  });
}

// ---------------------------------------------------------------------------
// OpenCode config files

export type ConfigStyle = "v1" | "v2";

/** Servers in an OpenCode config file, in either layout. */
export function listServers(configText: string): { name: string; entry: unknown; style: ConfigStyle }[] {
  const { mcp, style } = inspect(configText);
  if (!mcp) return [];
  // In v1 a "timeout" key is the global setting unless it is itself a server.
  const map = style === "v2" ? mcp.servers : isObject(mcp.timeout) && typeof mcp.timeout.type === "string" ? mcp : omit(mcp, "timeout");
  if (!isObject(map)) return [];
  return Object.entries(map).map(([name, entry]) => ({ name, entry, style }));
}

/**
 * Adds or replaces one server, keeping the rest of the file (comments,
 * formatting, other keys) as it was. A file already in the OpenCode 1 layout
 * (`mcp.<name>`) gets a v1 entry, since the two layouts cannot be mixed.
 */
export function upsertServer(configText: string, name: string, entry: McpServerEntry, opts: { eol?: string } = {}): string {
  const fmt = formatting(configText, opts.eol);
  if (!configText.trim()) {
    const indent = fmt.insertSpaces ? " ".repeat(fmt.tabSize) : "\t";
    const doc = { $schema: OPENCODE_SCHEMA, mcp: { servers: { [name]: entry } } };
    return JSON.stringify(doc, null, indent).replace(/\n/g, fmt.eol) + fmt.eol;
  }
  const { style } = inspect(configText);
  const [at, value] = style === "v1" ? [["mcp", name], toV1(entry)] : [["mcp", "servers", name], entry];
  return edit(configText, at, value, fmt);
}

export function removeServer(configText: string, name: string): string {
  const at = serverPath(configText, name);
  if (!at) return configText;
  return edit(configText, at, undefined, formatting(configText));
}

/** Turns a server off or back on in either layout; a no-op when it is not there. */
export function setDisabled(configText: string, name: string, disabled: boolean): string {
  const at = serverPath(configText, name);
  if (!at) return configText;
  const { style } = inspect(configText);
  // Enabling removes the flag rather than writing the default.
  const [key, value] = style === "v1" ? ["enabled", disabled ? false : undefined] : ["disabled", disabled ? true : undefined];
  return edit(configText, [...at, key], value, formatting(configText));
}

/**
 * modify() with formatting reflows every line the edit touches, so a one-line
 * sibling such as `"time": { "type": "local", ... },` would be expanded. Edit
 * raw instead and format only the inserted text and the gaps at its ends (a
 * removal leaves one gap). Inside a one-line object that already has members
 * the change stays on that line; elsewhere it is laid out with the file's
 * indentation.
 */
function edit(text: string, at: JSONPath, value: unknown, fmt: FormattingOptions): string {
  const raw = modify(text, at, value, {});
  if (raw.length !== 1) return applyEdits(text, raw);
  const [e] = raw;
  const container = deepestExisting(parseTree(text), at.slice(0, -1));
  const oneLine =
    !!container?.children?.length && !/[\r\n]/.test(text.slice(container.offset, container.offset + container.length));
  const next = applyEdits(text, raw);
  let start = Math.max(0, e.offset - 1);
  let end = Math.min(next.length, e.offset + e.content.length + 1);
  // Never split a CRLF: the formatter would rewrite half of it.
  if (next[start] === "\n" && next[start - 1] === "\r") start--;
  if (next[end - 1] === "\r" && next[end] === "\n") end++;
  return applyEdits(next, format(next, { offset: start, length: end - start }, { ...fmt, keepLines: oneLine }));
}

function deepestExisting(tree: JsonNode | undefined, at: JSONPath): JsonNode | undefined {
  if (!tree) return undefined;
  for (let i = at.length; i >= 0; i--) {
    const node = findNodeAtLocation(tree, at.slice(0, i));
    if (node) return node.type === "object" ? node : undefined;
  }
  return undefined;
}

function toV1(entry: McpServerEntry): Record<string, unknown> {
  const enabled = entry.disabled === undefined ? {} : { enabled: !entry.disabled };
  if (entry.type === "remote") {
    return { type: "remote", url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}), ...enabled };
  }
  // OpenCode 1 local servers have no cwd.
  return { type: "local", command: entry.command, ...(entry.environment ? { environment: entry.environment } : {}), ...enabled };
}

function serverPath(configText: string, name: string): string[] | undefined {
  const found = listServers(configText).find((s) => s.name === name);
  if (!found) return undefined;
  return found.style === "v1" ? ["mcp", name] : ["mcp", "servers", name];
}

function inspect(configText: string): { mcp?: Record<string, unknown>; style: ConfigStyle } {
  if (!configText.trim()) return { style: "v2" };
  const root = parseJsonc(configText);
  const mcp = isObject(root) && isObject(root.mcp) ? root.mcp : undefined;
  if (!mcp) return { style: "v2" };
  // v2 is exactly {servers?, timeout?}; a v1 server could itself be called
  // "servers" or "timeout", which shows as an object with a "type".
  const v1 =
    Object.keys(mcp).some((k) => k !== "servers" && k !== "timeout") ||
    (isObject(mcp.servers) && typeof mcp.servers.type === "string") ||
    (isObject(mcp.timeout) && typeof mcp.timeout.type === "string");
  return { mcp, style: v1 ? "v1" : "v2" };
}

function formatting(text: string, eol?: string): Required<Pick<FormattingOptions, "insertSpaces" | "tabSize" | "eol">> {
  const indent = inferIndent(text);
  return {
    insertSpaces: indent !== "\t",
    tabSize: indent === "\t" ? 1 : indent.length,
    eol: eol ?? (text.includes("\r\n") ? "\r\n" : "\n"),
  };
}

/** The file's indent unit; two spaces when nothing is indented yet. */
function inferIndent(text: string): string {
  let min = Infinity;
  for (const line of text.split(/\r?\n/)) {
    // Only lines that start a key or close a block: block comments and
    // wrapped strings have arbitrary leading space.
    const m = /^([ \t]+)["}\]]/.exec(line);
    if (!m) continue;
    if (m[1].startsWith("\t")) return "\t";
    min = Math.min(min, m[1].length);
  }
  return min === Infinity ? "  " : " ".repeat(min);
}

// ---------------------------------------------------------------------------
// Cost and locations

/**
 * Rough per-request token cost of a server's tool definitions (chars / 4 of
 * the JSON the model is sent), for a "this adds ~N tokens" warning.
 */
export function estimateToolTokens(tools: { name: string; description?: string; inputSchema?: unknown }[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += JSON.stringify({ name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? {} }).length;
  }
  return Math.ceil(chars / 4);
}

/** Project config files in the order `opencode mcp add` looks for them; write to the first that exists, else the first. */
export function projectConfigCandidates(root: string): string[] {
  return [
    path.join(root, "opencode.json"),
    path.join(root, "opencode.jsonc"),
    path.join(root, ".opencode", "opencode.json"),
    path.join(root, ".opencode", "opencode.jsonc"),
  ];
}

/** The user's global OpenCode config directory. */
export function globalConfigDir(env: Record<string, string | undefined> = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "opencode");
}

/** Global config files, in the same order as the project ones. */
export function globalConfigCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const dir = globalConfigDir(env);
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
}

/** Where VS Code (and Insiders, VSCodium) keep the default profile's user-level mcp.json. */
export function vscodeUserMcpPaths(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  let base: string;
  if (platform === "darwin") base = p.join(home, "Library", "Application Support");
  else if (platform === "win32") base = env.APPDATA || p.join(home, "AppData", "Roaming");
  else base = env.XDG_CONFIG_HOME || p.join(home, ".config");
  return ["Code", "Code - Insiders", "VSCodium"].map((product) => p.join(base, product, "User", "mcp.json"));
}

// ---------------------------------------------------------------------------

function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split("\n").length;
    throw new Error(`Invalid JSON (${printParseErrorCode(e.error)} on line ${line}).`);
  }
  return value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = o;
  return rest;
}
