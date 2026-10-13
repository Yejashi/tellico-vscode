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
  updated: number;
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

  async session(id: string): Promise<SessionInfo> {
    return toSessionInfo(await this.call<any>("GET", `/api/session/${id}`));
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

  prompt(id: string, text: string, files: { uri: string; name?: string }[] = []): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/prompt`, { text, files });
  }

  command(id: string, name: string, text: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/command`, { name, text });
  }

  interrupt(id: string): Promise<unknown> {
    return this.call("POST", `/api/session/${id}/interrupt`, {});
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

  /** Unified patches for every file the session changed. */
  async diff(id: string): Promise<FileDiff[]> {
    return (await this.call<FileDiff[]>("GET", `/api/session/${id}/diff`)) ?? [];
  }

  /**
   * The node the launcher chose for this device. Read from the default model's
   * provider id only: the same payload carries the API key, so nothing else
   * from it may leave this method.
   */
  async defaultNode(): Promise<0 | 1 | undefined> {
    const m = await this.call<any>("GET", "/api/model/default");
    const match = /^tellico-([01])$/.exec(String(m?.providerID ?? ""));
    return match ? (Number(match[1]) as 0 | 1) : undefined;
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
    updated: s.time?.updated ?? s.time?.created ?? 0,
  };
}
