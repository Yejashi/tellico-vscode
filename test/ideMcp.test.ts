import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdeMcpServer, IdeTool } from "../src/ide/mcpServer";

const tools: IdeTool[] = [
  {
    name: "echo",
    description: "Echo the input.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    call: async (args) => ({ text: String(args.text) }),
  },
  {
    name: "boom",
    description: "Always throws.",
    inputSchema: { type: "object", properties: {} },
    call: async () => {
      throw new Error("kaboom");
    },
  },
  {
    name: "alpha",
    description: "Listed last despite its name.",
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ text: "nope", isError: true }),
  },
];

let server: IdeMcpServer;
let url: string;
let token: string;

beforeEach(async () => {
  server = new IdeMcpServer(tools, { name: "test-ide", version: "1.2.3" });
  ({ url, token } = await server.start());
});

afterEach(async () => {
  await server.stop();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Json = any;

async function rpc(method: string, params?: unknown): Promise<Json> {
  const res = await post({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return res.json();
}

describe("IdeMcpServer", () => {
  it("listens on loopback with a 64-char hex token", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects missing and wrong tokens", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(msg, { Authorization: "" })).status).toBe(401);
    expect((await post(msg, { Authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await post(msg, { Authorization: "Bearer short" })).status).toBe(401);
    expect((await post(msg, { Authorization: `Basic ${token}` })).status).toBe(401);
  });

  it("rejects non-loopback origins and accepts loopback ones", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(msg, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(msg, { Origin: "http://127.0.0.1.evil.example" })).status).toBe(403);
    expect((await post(msg, { Origin: "null" })).status).toBe(403);
    expect((await post(msg, { Origin: "http://127.0.0.1:1234" })).status).toBe(200);
    expect((await post(msg, { Origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("negotiates the protocol version", async () => {
    const known = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } });
    expect(known.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "test-ide", version: "1.2.3" },
    });
    const unknown = await rpc("initialize", { protocolVersion: "2024-01-01", capabilities: {} });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("does not issue a session id", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers notifications and responses with 202 and no body", async () => {
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": "2025-06-18" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const resp = await post({ jsonrpc: "2.0", id: 9, result: {} });
    expect(resp.status).toBe(202);
  });

  it("answers ping", async () => {
    expect(await rpc("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("lists tools in the order given", async () => {
    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom", "alpha"]);
    expect(result.tools[0]).toEqual({ name: "echo", description: tools[0].description, inputSchema: tools[0].inputSchema });
  });

  it("calls a tool", async () => {
    const { result } = await rpc("tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }] });
    const err = await rpc("tools/call", { name: "alpha" });
    expect(err.result).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });

  it("reports an unknown tool as a tool error, not a protocol error", async () => {
    const res = await rpc("tools/call", { name: "nosuch", arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("nosuch");
  });

  it("reports a throwing tool as a tool error with its message", async () => {
    const { result } = await rpc("tools/call", { name: "boom", arguments: {} });
    expect(result).toEqual({ content: [{ type: "text", text: "kaboom" }], isError: true });
  });

  it("rejects bad tools/call params", async () => {
    expect((await rpc("tools/call", { arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "echo", arguments: [1] })).error.code).toBe(-32602);
  });

  it("returns -32700 for invalid JSON", async () => {
    const res = await post("{not json");
    const body: Json = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("returns -32601 for an unknown method", async () => {
    const body = await rpc("resources/list");
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
  });

  it("handles a batch", async () => {
    const res = await post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "echo", arguments: { text: "x" } } },
    ]);
    expect(res.status).toBe(200);
    const body: Json = await res.json();
    expect(body.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
  });

  it("returns 405 for GET and DELETE, 404 elsewhere", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await fetch(url.replace(/\/mcp$/, "/other"), { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
  });

  it("returns 413 for a body over 1 MB", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024 + 1) } });
    expect(res.status).toBe(413);
  });

  it("closes the port on stop", async () => {
    await server.stop();
    await expect(post({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
  });
});
