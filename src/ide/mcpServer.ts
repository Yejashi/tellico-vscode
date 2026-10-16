// A tiny MCP server (Streamable HTTP, spec 2025-06-18) that lets the coding
// agent ask VS Code things only the editor knows: diagnostics, open editors,
// the selection. Loopback only, a random bearer token, stateless (no
// Mcp-Session-Id), JSON responses only -- no SSE, no server-initiated
// messages. Knows nothing about vscode so it can be tested in plain Node;
// the tools come from ./tools.

import * as http from "http";
import { AddressInfo } from "net";
import { randomBytes, timingSafeEqual } from "crypto";

export interface IdeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

const PATH = "/mcp";
const MAX_BODY = 1024 * 1024;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Id = string | number | null;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class IdeMcpServer {
  private server?: http.Server;
  private token = "";
  private readonly name: string;
  private readonly version: string;
  private readonly instructions?: string;

  constructor(private readonly tools: IdeTool[], opts: { name?: string; version?: string; instructions?: string } = {}) {
    this.name = opts.name ?? "vscode";
    this.version = opts.version ?? "0.0.0";
    this.instructions = opts.instructions;
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.server) throw new Error("IDE MCP server already started");
    this.token = randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500);
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}${PATH}`, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // DNS-rebinding defence: a browser page on another origin must not reach
    // us even if it learnt the port.
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return send(res, 403);
    if (!this.authorized(req.headers.authorization)) {
      return send(res, 401, undefined, { "WWW-Authenticate": "Bearer" });
    }
    const path = (req.url ?? "").split("?")[0];
    if (path !== PATH) return send(res, 404);
    if (req.method !== "POST") return send(res, 405, undefined, { Allow: "POST" });

    const body = await readBody(req);
    if (body === undefined) return send(res, 413, undefined, { Connection: "close" });

    let msg: unknown;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch {
      return send(res, 400, errorResponse(null, PARSE_ERROR, "Parse error"));
    }

    if (Array.isArray(msg)) {
      if (msg.length === 0) return send(res, 400, errorResponse(null, INVALID_REQUEST, "Empty batch"));
      const out = (await Promise.all(msg.map((m) => this.dispatch(m)))).filter((r) => r !== undefined);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = await this.dispatch(msg);
    return out !== undefined ? send(res, 200, out) : send(res, 202);
  }

  private authorized(header: string | undefined): boolean {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
    if (!m) return false;
    const got = Buffer.from(m[1]);
    const want = Buffer.from(this.token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** One JSON-RPC message in, its response out (undefined for notifications and responses). */
  private async dispatch(msg: unknown): Promise<unknown> {
    if (!isObject(msg)) return errorResponse(null, INVALID_REQUEST, "Invalid request");
    const hasId = "id" in msg && msg.id !== undefined;
    if (typeof msg.method !== "string") {
      // A response to something we never sent (we send no requests): ignore.
      return hasId && ("result" in msg || "error" in msg) ? undefined : errorResponse(idOf(msg), INVALID_REQUEST, "Invalid request");
    }
    if (!hasId) return undefined; // notification: initialized, cancelled, ...
    const id = idOf(msg);
    try {
      const result = await this.method(msg.method, msg.params);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message);
      return errorResponse(id, -32603, errorMessage(err));
    }
  }

  private async method(method: string, params: unknown): Promise<unknown> {
    if (params !== undefined && !isObject(params)) throw new RpcError(INVALID_PARAMS, "params must be an object");
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": {
        const asked = p.protocolVersion;
        return {
          protocolVersion: typeof asked === "string" && VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      case "tools/call": {
        if (typeof p.name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name");
        if (p.arguments !== undefined && !isObject(p.arguments)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
        const tool = this.tools.find((t) => t.name === p.name);
        if (!tool) return toolResult(`Unknown tool: ${p.name}`, true);
        try {
          const r = await tool.call((p.arguments ?? {}) as Record<string, unknown>);
          return toolResult(r.text, r.isError);
        } catch (err) {
          return toolResult(errorMessage(err), true);
        }
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

function toolResult(text: string, isError?: boolean) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorResponse(id: Id, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function idOf(msg: Record<string, unknown>): Id {
  return typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** The body, or undefined if it exceeds MAX_BODY (the rest is drained so the 413 reaches the client). */
function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = Number(req.headers["content-length"] ?? 0) > MAX_BODY;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => resolve(tooBig ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }).end(data);
}
