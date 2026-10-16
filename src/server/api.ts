// The only module that knows OpenCode 2's HTTP routes (/api/*, verified
// against 2.0.26's /openapi.json). A v1 adapter would be a sibling of this.
//
// Never pass a provider, model or config payload from here to the webview or
// a log: GET /api/model and /api/provider return the Tellico API key in
// `settings.apiKey`. Methods below return only the fields the UI needs.

import { ModelRef } from "../../shared/model";

export interface Connection {
  baseUrl: string;
  password: string;
  directory: string;
}

export interface AgentInfo {
  id: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  variant?: string;
  modelID?: string;
  providerID?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  parentID?: string;
  agent?: string;
  model?: ModelRef;
  created: number;
  updated: number;
}

export interface PromptFile {
  /** file:// (optionally ?start=&end= for 1-based lines) or data: URI. */
  uri: string;
  name?: string;
  /** The span of the prompt text that refers to this file, e.g. "@src/a.ts". */
  mention?: { start: number; end: number; text: string };
}

export type Delivery = "steer" | "queue";

export interface McpServer {
  name: string;
  status: "connected" | "pending" | "disabled" | "failed" | "needs_auth";
  error?: string;
  /** Set for remote servers; OAuth goes through this integration. */
  integrationID?: string;
}

export interface OAuthAttempt {
  attemptID: string;
  url: string;
  instructions?: string;
  mode: "auto" | "code";
}

export interface SavedPermission {
  id: string;
  action: string;
  resource: string;
  time: number;
}

export interface ModelLimits {
  context: number;
  output: number;
}

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 60_000;

export class Api {
  constructor(private readonly conn: Connection) {}

  get auth(): string {
    return "Basic " + Buffer.from(`opencode:${this.conn.password}`).toString("base64");
  }

  url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(path, this.conn.baseUrl);
    u.searchParams.set("directory", this.conn.directory);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path, query), {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Every call here answers at once (prompts are only enqueued); a hung
      // server must not leave a button that does nothing.
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const j = JSON.parse(text);
        message = j?.message ?? j?.error?.message ?? j?.data?.message ?? text;
      } catch {}
      throw new ApiError(res.status, `${method} ${path}: ${res.status} ${String(message).slice(0, 300)}`);
    }
    if (!text) return undefined as T;
    const json = JSON.parse(text);
    return (json && typeof json === "object" && "data" in json ? json.data : json) as T;
  }

  async agents(): Promise<AgentInfo[]> {
    const list = await this.call<any[]>("GET", "/api/agent");
    return (list ?? []).map((a) => ({
      id: a.id,
      description: a.description,
      mode: a.mode,
      hidden: a.hidden,
      variant: a.model?.variant,
      modelID: a.model?.id,
      providerID: a.model?.providerID,
    }));
  }

  async commands(): Promise<CommandInfo[]> {
    const list = await this.call<any[]>("GET", "/api/command");
    return (list ?? []).map((c) => ({ name: c.name, description: c.description }));
  }

  /** Most recent first; top-level sessions only (subagents are reached from their parent). */
  async sessions(limit = 50): Promise<SessionInfo[]> {
    const list = await this.call<any[]>("GET", "/api/session", undefined, { limit: String(limit), order: "desc", parentID: "null" });
    return (list ?? []).map(toSessionInfo).filter((s) => !s.parentID);
  }

  /** Server-side title search; most recent first, top-level only. */
  async searchSessions(search: string, limit = 50): Promise<SessionInfo[]> {
    const list = await this.call<any[]>("GET", "/api/session", undefined, { limit: String(limit), order: "desc", parentID: "null", search });
    return (list ?? []).map(toSessionInfo).filter((s) => !s.parentID);
  }

  async children(parentID: string): Promise<SessionInfo[]> {
    const list = await this.call<any[]>("GET", "/api/session", undefined, { parentID, limit: "50" });
    return (list ?? []).map(toSessionInfo);
  }

  /** Ids of sessions with a running turn. */
  async active(): Promise<string[]> {
    return Object.keys((await this.call<Record<string, unknown>>("GET", "/api/session/active")) ?? {});
  }

  async session(id: string): Promise<SessionInfo> {
    return toSessionInfo(await this.call<any>("GET", `/api/session/${id}`));
  }

  /** The raw Session.Info, for Store.loadHistory (revert, cost, metadata). */
  sessionRaw(id: string): Promise<any> {
    return this.call<any>("GET", `/api/session/${id}`);
  }

  rename(id: string, title: string): Promise<unknown> {
    return this.call("PATCH", `/api/session/${id}`, { title });
  }

  setMetadata(id: string, metadata: Record<string, unknown>): Promise<unknown> {
    return this.call("PATCH", `/api/session/${id}`, { metadata });
  }

  /** Marks the latest idle transition seen, so other clients drop their unread dot. */
  view(id: string, idle: number): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/view`, { idle });
  }

  async createSession(agent: string, model: ModelRef): Promise<SessionInfo> {
    return toSessionInfo(
      await this.call<any>("POST", "/api/session", { agent, model, location: { directory: this.conn.directory } }),
    );
  }

  /** Newest first, as the server returns them; follows the cursor. */
  async messages(id: string, max = 2000): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const res = await fetch(this.url(`/api/session/${id}/message`, cursor ? { cursor } : {}), {
        headers: { Authorization: this.auth },
      });
      if (!res.ok) throw new ApiError(res.status, `GET messages: ${res.status}`);
      const json: any = await res.json();
      out.push(...(json.data ?? []));
      const next = json.cursor?.next;
      if (!next || !(json.data ?? []).length) break;
      cursor = String(next);
    }
    return out;
  }

  /**
   * Admits a prompt. `steer` (the server default) joins the running turn at
   * its next step; `queue` waits until the turn ends.
   */
  prompt(id: string, text: string, files: PromptFile[] = [], delivery?: Delivery): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/prompt`, { text, files, ...(delivery ? { delivery } : {}) });
  }

  command(id: string, name: string, text: string, delivery?: Delivery): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/command`, { name, text, ...(delivery ? { delivery } : {}) });
  }

  interrupt(id: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/interrupt`, {});
  }

  /** Runs a shell command in the session's directory, with no model turn. */
  shell(id: string, command: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/shell`, { command });
  }

  compact(id: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/compact`, {});
  }

  /** Pending inbox items (prompts not yet delivered). */
  inbox(id: string): Promise<any[]> {
    return this.call<any[]>("GET", `/api/session/${id}/inbox`).then((l) => l ?? []);
  }

  cancelInbox(id: string, inboxID: string): Promise<unknown> {
    return this.call("DELETE", `/api/session/${id}/inbox/${inboxID}`);
  }

  /** Moves a queued prompt into the running turn. */
  steerInbox(id: string, inboxID: string): Promise<unknown> {
    return this.call("PATCH", `/api/session/${id}/inbox/${inboxID}`, { delivery: "steer" });
  }

  /**
   * Sets the transcript aside from `messageID` on and, with `files`, restores
   * the files those steps changed. Staged until cleared or committed; the next
   * prompt commits it.
   */
  revertStage(id: string, messageID: string, files = true): Promise<{ files: string[] }> {
    return this.call<any>("POST", `/api/session/${id}/revert/stage`, { messageID, files }).then((r) => ({
      files: (r?.files ?? []).map((f: any) => String(f.file)),
    }));
  }

  revertClear(id: string): Promise<unknown> {
    return this.call("DELETE", `/api/session/${id}/revert`);
  }

  revertCommit(id: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/revert/commit`);
  }

  switchAgent(id: string, agent: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/agent`, { agent });
  }

  switchModel(id: string, model: ModelRef): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/model`, { model });
  }

  replyPermission(id: string, requestID: string, decision: "once" | "always" | "reject", message?: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/permission/${requestID}/reply`, { decision, ...(message ? { message } : {}) });
  }

  pendingPermissions(): Promise<any[]> {
    return this.call<any[]>("GET", "/api/permission/request");
  }

  pendingForms(id: string): Promise<any[]> {
    return this.call<any[]>("GET", `/api/session/${id}/form`);
  }

  replyForm(id: string, formID: string, answer: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/form/${formID}/reply`, { answer });
  }

  cancelForm(id: string, formID: string): Promise<unknown> {
    return this.call("DELETE", `/api/session/${id}/form/${formID}`);
  }

  /** A copy of the session, ending before `before` when given. */
  fork(id: string, before?: string): Promise<SessionInfo> {
    return this.call<any>("POST", `/api/session/${id}/fork`, before ? { before } : {}).then(toSessionInfo);
  }

  remove(id: string): Promise<unknown> {
    return this.call("DELETE", `/api/session/${id}`);
  }

  /**
   * Unified patches for the files changed between the turns of user messages
   * `from` and `to` (inclusive). With neither, only the newest turn: pass the
   * first and last user message for the whole session.
   */
  async diff(id: string, range: { from?: string; to?: string } = {}): Promise<FileDiff[]> {
    const q: Record<string, string> = {};
    if (range.from) q.from = range.from;
    if (range.to && range.to !== range.from) q.to = range.to;
    return (await this.call<FileDiff[]>("GET", `/api/session/${id}/diff`, undefined, q)) ?? [];
  }

  /** Fuzzy file search in the workspace, for @-mentions. */
  async findFiles(query: string, limit = 12): Promise<{ path: string; type: "file" | "directory" }[]> {
    const list = await this.call<any[]>("GET", "/api/fs/find", undefined, { query, limit: String(limit) });
    return (list ?? []).map((f) => ({ path: String(f.path), type: f.type === "directory" ? "directory" : "file" }));
  }

  async vcs(): Promise<{ branch?: string } | undefined> {
    const v = await this.call<any>("GET", "/api/vcs").catch(() => undefined);
    return v ? { branch: v.branch?.current ?? undefined } : undefined;
  }

  // ---------- MCP ----------

  async mcp(): Promise<McpServer[]> {
    const list = await this.call<any[]>("GET", "/api/mcp");
    return (list ?? []).map((m) => ({
      name: String(m.name),
      status: m.status?.status ?? m.status ?? "pending",
      error: m.status?.error ?? undefined,
      integrationID: m.integrationID ?? undefined,
    }));
  }

  /** Adds or replaces a server for this server's lifetime; connects at once. */
  addMcp(name: string, config: Record<string, unknown>): Promise<unknown> {
    return this.call("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, { config });
  }

  removeMcp(name: string): Promise<unknown> {
    return this.call("DELETE", `/api/experimental/mcp/${encodeURIComponent(name)}`);
  }

  connectMcp(name: string): Promise<unknown> {
    return this.call("POST", `/api/experimental/mcp/${encodeURIComponent(name)}/connect`);
  }

  disconnectMcp(name: string): Promise<unknown> {
    return this.call("POST", `/api/experimental/mcp/${encodeURIComponent(name)}/disconnect`);
  }

  /** Starts an MCP server's OAuth sign-in. Returns only the attempt, never credentials. */
  async startOAuth(integrationID: string): Promise<OAuthAttempt | undefined> {
    const info = await this.call<any>("GET", `/api/integration/${integrationID}`);
    const method = (info?.methods ?? []).find((m: any) => m.type === "oauth");
    if (!method) return undefined;
    const a = await this.call<any>("POST", `/api/integration/${integrationID}/connect/oauth`, { methodID: method.id });
    return { attemptID: String(a.attemptID), url: String(a.url), instructions: a.instructions ?? undefined, mode: a.mode === "code" ? "code" : "auto" };
  }

  async oauthStatus(integrationID: string, attemptID: string): Promise<string> {
    const r = await this.call<any>("GET", `/api/integration/${integrationID}/connect/oauth/${attemptID}`);
    return String(r?.status ?? "pending");
  }

  completeOAuth(integrationID: string, attemptID: string, code: string): Promise<unknown> {
    return this.call("POST", `/api/integration/${integrationID}/connect/oauth/${attemptID}/complete`, { code });
  }

  // ---------- permissions ----------

  /** "Always allow" grants this project has saved. */
  async savedPermissions(): Promise<SavedPermission[]> {
    const list = await this.call<any[]>("GET", "/api/permission/saved");
    return (list ?? []).map((p) => ({ id: String(p.id), action: String(p.action), resource: String(p.resource), time: Number(p.time?.created ?? p.time ?? 0) }));
  }

  removeSavedPermission(id: string): Promise<unknown> {
    return this.call("DELETE", `/api/permission/saved/${id}`);
  }

  /**
   * The node the launcher chose for this device. Read from the default model's
   * provider id only: the same payload carries the API key, so nothing else
   * from it may leave this method.
   */
  async defaultNode(): Promise<0 | 1 | undefined> {
    return (await this.defaultModel()).node;
  }

  /**
   * The launcher's node choice and the model's token limits, read from the
   * default model. Only these numbers leave this method: the same payload
   * carries the API key.
   */
  async defaultModel(): Promise<{ node?: 0 | 1; limits?: ModelLimits }> {
    const m = await this.call<any>("GET", "/api/model/default");
    const match = /^tellico-([01])$/.exec(String(m?.providerID ?? ""));
    const context = Number(m?.limit?.context);
    const output = Number(m?.limit?.output);
    return {
      node: match ? (Number(match[1]) as 0 | 1) : undefined,
      limits: context > 0 ? { context, output: output > 0 ? output : 0 } : undefined,
    };
  }

  async ready(): Promise<boolean> {
    try {
      const agents = await this.agents();
      return agents.some((a) => /-tellico-[01]$/.test(a.id));
    } catch {
      return false;
    }
  }
}

function toSessionInfo(s: any): SessionInfo {
  return {
    id: s.id,
    title: s.title ?? "New session",
    parentID: s.parentID ?? undefined,
    agent: s.agent ?? undefined,
    model: s.model ?? undefined,
    created: s.time?.created ?? 0,
    updated: s.time?.updated ?? s.time?.created ?? 0,
  };
}
