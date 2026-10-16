import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimateToolTokens,
  globalConfigCandidates,
  globalConfigDir,
  listServers,
  parseVsCodeMcp,
  projectConfigCandidates,
  removeServer,
  sanitizeName,
  setDisabled,
  upsertServer,
  vscodeUserMcpPaths,
  type McpServerEntry,
} from "../src/mcp/config";

const vars = { workspaceFolder: "/work/proj", userHome: "/home/u", env: { GH_TOKEN: "ghp_x", EMPTY: "" } };
const local: McpServerEntry = { type: "local", command: ["node", "server.js"], environment: { A: "1" } };
const remote: McpServerEntry = { type: "remote", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer t" } };

describe("parseVsCodeMcp", () => {
  it("translates stdio, http, sse and type-less servers", () => {
    const text = JSON.stringify({
      servers: {
        fs: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { DEBUG: "1" }, cwd: "/tmp" },
        web: { type: "http", url: "https://a.example/mcp", headers: { "X-Key": "k" } },
        events: { type: "sse", url: "https://b.example/sse" },
        bare: { command: "uvx", args: ["mcp-server-time"] },
        bareUrl: { url: "https://c.example/mcp" },
      },
    });
    const out = parseVsCodeMcp(text, vars);
    expect(out).toEqual([
      {
        name: "fs",
        entry: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], cwd: "/tmp", environment: { DEBUG: "1" } },
        problems: [],
      },
      { name: "web", entry: { type: "remote", url: "https://a.example/mcp", headers: { "X-Key": "k" } }, problems: [] },
      { name: "events", entry: { type: "remote", url: "https://b.example/sse" }, problems: [] },
      { name: "bare", entry: { type: "local", command: ["uvx", "mcp-server-time"] }, problems: [] },
      { name: "bareUrl", entry: { type: "remote", url: "https://c.example/mcp" }, problems: [] },
    ]);
  });

  it("substitutes workspaceFolder, userHome, env and pathSeparator", () => {
    const text = JSON.stringify({
      servers: {
        s: {
          command: "${userHome}/bin/srv",
          args: ["--root", "${workspaceFolder}", "--sep=${pathSeparator}", "${/}"],
          env: { TOKEN: "${env:GH_TOKEN}", E: "x${env:EMPTY}y" },
          cwd: "${workspaceFolder}/sub",
        },
        r: { type: "http", url: "https://x.example/${env:GH_TOKEN}", headers: { Authorization: "Bearer ${env:GH_TOKEN}" } },
      },
    });
    const [s, r] = parseVsCodeMcp(text, vars);
    expect(s.problems).toEqual([]);
    expect(s.entry).toEqual({
      type: "local",
      command: ["/home/u/bin/srv", "--root", "/work/proj", `--sep=${path.sep}`, path.sep],
      cwd: "/work/proj/sub",
      environment: { TOKEN: "ghp_x", E: "xy" },
    });
    expect(r.entry).toEqual({ type: "remote", url: "https://x.example/ghp_x", headers: { Authorization: "Bearer ghp_x" } });
  });

  it("leaves ${input:…} and unknown variables in place and reports them once", () => {
    const text = JSON.stringify({
      inputs: [{ id: "token", type: "promptString", password: true }],
      servers: {
        gh: {
          type: "http",
          url: "https://api.example/mcp",
          headers: { Authorization: "Bearer ${input:token}", Other: "${input:token}" },
        },
        x: { command: "srv", args: ["${env:NOPE}", "${config:editor.fontSize}"] },
      },
    });
    const [gh, x] = parseVsCodeMcp(text, vars);
    expect(gh.entry).toEqual({
      type: "remote",
      url: "https://api.example/mcp",
      headers: { Authorization: "Bearer ${input:token}", Other: "${input:token}" },
    });
    expect(gh.problems).toEqual(["uses ${input:token}, which only VS Code can prompt for; set it in opencode.json by hand"]);
    expect(x.entry).toEqual({ type: "local", command: ["srv", "${env:NOPE}", "${config:editor.fontSize}"] });
    expect(x.problems).toHaveLength(2);
    expect(x.problems[0]).toContain("${env:NOPE}");
    expect(x.problems[1]).toContain("${config:editor.fontSize}");
  });

  it("reports unresolvable workspace variables when no folder is open", () => {
    const [s] = parseVsCodeMcp(JSON.stringify({ servers: { s: { command: "${workspaceFolder}/run" } } }), {});
    expect(s.entry).toEqual({ type: "local", command: ["${workspaceFolder}/run"] });
    expect(s.problems[0]).toContain("${workspaceFolder}");
  });

  it("reports envFile and skips what it cannot translate", () => {
    const text = JSON.stringify({
      servers: {
        withEnvFile: { command: "srv", envFile: "${workspaceFolder}/.env" },
        noCommand: { type: "stdio" },
        weird: { type: "websocket", url: "ws://x" },
        nothing: { foo: 1 },
      },
    });
    const [a, b, c, d] = parseVsCodeMcp(text, vars);
    expect(a.entry).toEqual({ type: "local", command: ["srv"] });
    expect(a.problems).toEqual(["envFile is not supported by OpenCode; variables from it are not imported"]);
    expect(b.entry).toBeUndefined();
    expect(b.problems[0]).toContain("command");
    expect(c.entry).toBeUndefined();
    expect(c.problems[0]).toContain("websocket");
    expect(d.entry).toBeUndefined();
  });

  it("accepts the Claude Desktop / Cursor mcpServers shape", () => {
    const text = JSON.stringify({
      mcpServers: {
        github: { command: "docker", args: ["run", "-i", "ghcr.io/github/github-mcp-server"], env: { GITHUB_TOKEN: "t" } },
        linear: { url: "https://mcp.linear.app/sse" },
        off: { command: "srv", disabled: true },
      },
    });
    expect(parseVsCodeMcp(text, vars).map((r) => r.entry)).toEqual([
      { type: "local", command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"], environment: { GITHUB_TOKEN: "t" } },
      { type: "remote", url: "https://mcp.linear.app/sse" },
      { type: "local", command: ["srv"], disabled: true },
    ]);
  });

  it("accepts a bare server map pasted without its wrapper", () => {
    const out = parseVsCodeMcp('{ "time": { "command": "uvx", "args": ["mcp-server-time"] } }', vars);
    expect(out).toEqual([{ name: "time", entry: { type: "local", command: ["uvx", "mcp-server-time"] }, problems: [] }]);
  });

  it("parses JSONC with comments and trailing commas", () => {
    const text = `{
  // VS Code writes these
  "inputs": [],
  "servers": {
    /* the time server */
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time",], // trailing comma
    },
  },
}`;
    expect(parseVsCodeMcp(text, vars)).toEqual([{ name: "time", entry: { type: "local", command: ["uvx", "mcp-server-time"] }, problems: [] }]);
  });

  it("throws on invalid JSON or a file with no servers", () => {
    expect(() => parseVsCodeMcp("{ servers: ", vars)).toThrow(/Invalid JSON/);
    expect(() => parseVsCodeMcp('{"inputs": []}', vars)).toThrow(/servers/);
    expect(() => parseVsCodeMcp("[]", vars)).toThrow();
  });

  it("sanitizes names, keeps the original, and avoids collisions", () => {
    const text = JSON.stringify({
      servers: { "@scope/server.github": { command: "a" }, "scope server github": { command: "b" }, "!!!": { command: "c" }, ok_name: { command: "d" } },
    });
    const out = parseVsCodeMcp(text, vars);
    expect(out.map((r) => r.name)).toEqual(["scope-server-github", "scope-server-github-2", "server", "ok_name"]);
    expect(out[0].originalName).toBe("@scope/server.github");
    expect(out[3].originalName).toBeUndefined();
    for (const r of out) expect(r.name).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("sanitizeName", () => {
  it("keeps valid names and makes others readable", () => {
    expect(sanitizeName("my-server_1")).toBe("my-server_1");
    expect(sanitizeName("io.github/foo bar")).toBe("io-github-foo-bar");
    expect(sanitizeName("  ")).toBe("server");
  });
});

describe("upsertServer", () => {
  it("creates a v2 file from empty input", () => {
    for (const empty of ["", "  \n"]) {
      const out = upsertServer(empty, "fs", local);
      expect(out).toBe(
        `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "fs": {
        "type": "local",
        "command": [
          "node",
          "server.js"
        ],
        "environment": {
          "A": "1"
        }
      }
    }
  }
}
`,
      );
      expect(listServers(out)).toEqual([{ name: "fs", entry: local, style: "v2" }]);
    }
  });

  it("honours a CRLF eol for a new file", () => {
    const out = upsertServer("", "r", remote, { eol: "\r\n" });
    expect(out).toContain('{\r\n  "$schema"');
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("adds to an existing v2 file, keeping comments and other keys", () => {
    const text = `{
  // my config
  "$schema": "https://opencode.ai/config.json",
  "model": "x/y", /* keep */
  "mcp": {
    "timeout": { "startup": 5000 },
    "servers": {
      // the old one
      "old": { "type": "remote", "url": "https://old.example" }
    }
  }
}
`;
    const out = upsertServer(text, "fs", local);
    expect(out).toContain("// my config");
    expect(out).toContain('"model": "x/y", /* keep */');
    expect(out).toContain("// the old one");
    expect(out).toContain('"timeout": { "startup": 5000 }');
    // the one-line sibling is not reflowed; the new entry uses the file's layout
    expect(out).toContain('\n      "old": { "type": "remote", "url": "https://old.example" },\n      "fs": {\n        "type": "local",\n');
    expect(listServers(out)).toEqual([
      { name: "old", entry: { type: "remote", url: "https://old.example" }, style: "v2" },
      { name: "fs", entry: local, style: "v2" },
    ]);
  });

  it("adds mcp.servers to a file without mcp", () => {
    const text = '{\n    "model": "x/y"\n}\n';
    const out = upsertServer(text, "r", remote);
    expect(out).toContain('    "model": "x/y"');
    expect(out).toMatch(/\n    "mcp": \{\n        "servers": \{/);
    expect(listServers(out)).toEqual([{ name: "r", entry: remote, style: "v2" }]);
  });

  it("writes the v1 shape into a v1-style file", () => {
    const text = `{
  "mcp": {
    // existing v1 server
    "time": { "type": "local", "command": ["uvx", "mcp-server-time"], "enabled": true }
  }
}`;
    const out = upsertServer(text, "fs", { ...local, cwd: "/tmp", disabled: true });
    expect(out).toContain("// existing v1 server");
    const servers = listServers(out);
    expect(servers.map((s) => [s.name, s.style])).toEqual([
      ["time", "v1"],
      ["fs", "v1"],
    ]);
    expect(servers[1].entry).toEqual({ type: "local", command: ["node", "server.js"], environment: { A: "1" }, enabled: false });
    expect(out).not.toContain('"servers"');

    const r = listServers(upsertServer(text, "r", { ...remote, disabled: false }))[1];
    expect(r.entry).toEqual({ type: "remote", url: remote.url, headers: remote.headers, enabled: true });
  });

  it("replaces an existing entry wholesale", () => {
    const first = upsertServer("", "s", { ...local, disabled: true });
    const second = upsertServer(first, "s", remote);
    expect(listServers(second)).toEqual([{ name: "s", entry: remote, style: "v2" }]);
    expect(second).not.toContain("disabled");
  });

  it("keeps tab indentation", () => {
    const text = '{\n\t"model": "x/y",\n\t"mcp": {\n\t\t"servers": {}\n\t}\n}\n';
    const out = upsertServer(text, "r", remote);
    expect(out).toContain('\n\t\t\t"r": {\n\t\t\t\t"type": "remote"');
    expect(out).not.toMatch(/\n +"/);
  });

  it("keeps CRLF line endings", () => {
    const text = '{\r\n  "model": "x/y"\r\n}\r\n';
    const out = upsertServer(text, "r", remote);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses to edit invalid JSON", () => {
    expect(() => upsertServer('{ "mcp": ', "r", remote)).toThrow(/Invalid JSON/);
  });
});

describe("removeServer and setDisabled", () => {
  const v2 = `{
  // keep me
  "mcp": {
    "servers": {
      "a": { "type": "local", "command": ["a"] },
      "b": { "type": "remote", "url": "https://b.example" }
    }
  }
}`;
  const v1 = `{
  // keep me
  "mcp": {
    "a": { "type": "local", "command": ["a"] },
    "b": { "type": "remote", "url": "https://b.example", "enabled": true }
  }
}`;

  it("removes from either style and leaves the rest", () => {
    for (const text of [v2, v1]) {
      const out = removeServer(text, "a");
      expect(out).toContain("// keep me");
      expect(listServers(out).map((s) => s.name)).toEqual(["b"]);
    }
  });

  it("keeps the layout when removing the first or the only server", () => {
    expect(removeServer(v2, "a")).toBe(`{
  // keep me
  "mcp": {
    "servers": {
      "b": { "type": "remote", "url": "https://b.example" }
    }
  }
}`);
    expect(removeServer(removeServer(v2, "a"), "b")).toBe(`{
  // keep me
  "mcp": {
    "servers": {}
  }
}`);
  });

  it("keeps a one-line entry on one line when toggling", () => {
    expect(setDisabled(v2, "b", true)).toContain('\n      "b": { "type": "remote", "url": "https://b.example", "disabled": true }\n');
    expect(setDisabled(setDisabled(v2, "b", true), "b", false)).toBe(v2);
    expect(setDisabled(v1, "b", true)).toContain('"b": { "type": "remote", "url": "https://b.example", "enabled": false }');
  });

  it("ignores servers that are not there", () => {
    expect(removeServer(v2, "zzz")).toBe(v2);
    expect(setDisabled(v1, "zzz", true)).toBe(v1);
    expect(removeServer("", "a")).toBe("");
  });

  it("toggles disabled in v2", () => {
    const off = setDisabled(v2, "b", true);
    expect(off).toContain("// keep me");
    expect(listServers(off)[1].entry).toEqual({ type: "remote", url: "https://b.example", disabled: true });
    const on = setDisabled(off, "b", false);
    expect(listServers(on)[1].entry).toEqual({ type: "remote", url: "https://b.example" });
  });

  it("toggles enabled in v1", () => {
    const off = setDisabled(v1, "b", true);
    expect(listServers(off)[1]).toEqual({ name: "b", style: "v1", entry: { type: "remote", url: "https://b.example", enabled: false } });
    const on = setDisabled(off, "b", false);
    expect(listServers(on)[1].entry).toEqual({ type: "remote", url: "https://b.example" });
    expect(listServers(setDisabled(v1, "a", true))[0].entry).toEqual({ type: "local", command: ["a"], enabled: false });
  });
});

describe("listServers", () => {
  it("handles files without mcp, empty mcp and timeout-only v2", () => {
    expect(listServers("")).toEqual([]);
    expect(listServers('{"model": "x"}')).toEqual([]);
    expect(listServers('{"mcp": {}}')).toEqual([]);
    expect(listServers('{"mcp": {"timeout": {"startup": 1}}}')).toEqual([]);
  });

  it("treats v1 servers named servers or timeout as v1", () => {
    const text = '{"mcp": {"servers": {"type": "local", "command": ["x"]}}}';
    expect(listServers(text)).toEqual([{ name: "servers", entry: { type: "local", command: ["x"] }, style: "v1" }]);
    const out = upsertServer(text, "y", remote);
    expect(listServers(out).map((s) => [s.name, s.style])).toEqual([
      ["servers", "v1"],
      ["y", "v1"],
    ]);
  });
});

describe("estimateToolTokens", () => {
  it("is zero for no tools and grows with size", () => {
    expect(estimateToolTokens([])).toBe(0);
    const one = estimateToolTokens([{ name: "read" }]);
    const described = estimateToolTokens([{ name: "read", description: "Read a file from disk." }]);
    const schema = { type: "object", properties: { path: { type: "string", description: "Absolute path" } }, required: ["path"] };
    const withSchema = estimateToolTokens([{ name: "read", description: "Read a file from disk.", inputSchema: schema }]);
    const two = estimateToolTokens([
      { name: "read", description: "Read a file from disk.", inputSchema: schema },
      { name: "write", description: "Write a file.", inputSchema: schema },
    ]);
    expect(one).toBeGreaterThan(0);
    expect(described).toBeGreaterThan(one);
    expect(withSchema).toBeGreaterThan(described);
    expect(two).toBeGreaterThan(withSchema);
  });

  it("is roughly chars / 4", () => {
    const description = "x".repeat(4000);
    const n = estimateToolTokens([{ name: "t", description }]);
    expect(n).toBeGreaterThanOrEqual(1000);
    expect(n).toBeLessThan(1100);
  });
});

describe("config locations", () => {
  it("lists project candidates in opencode mcp add order", () => {
    expect(projectConfigCandidates("/p")).toEqual([
      path.join("/p", "opencode.json"),
      path.join("/p", "opencode.jsonc"),
      path.join("/p", ".opencode", "opencode.json"),
      path.join("/p", ".opencode", "opencode.jsonc"),
    ]);
  });

  it("resolves the global config dir", () => {
    expect(globalConfigDir({ HOME: "/h" })).toBe(path.join("/h", ".config", "opencode"));
    expect(globalConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe(path.join("/x", "opencode"));
    expect(globalConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/x", OPENCODE_CONFIG_DIR: "/o" })).toBe("/o");
    expect(globalConfigCandidates({ OPENCODE_CONFIG_DIR: "/o" })).toEqual([path.join("/o", "opencode.json"), path.join("/o", "opencode.jsonc")]);
  });

  it("lists VS Code user mcp.json paths per platform", () => {
    expect(vscodeUserMcpPaths({ HOME: "/h" }, "linux")[0]).toBe("/h/.config/Code/User/mcp.json");
    expect(vscodeUserMcpPaths({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux")[1]).toBe("/x/Code - Insiders/User/mcp.json");
    expect(vscodeUserMcpPaths({ HOME: "/Users/u" }, "darwin")[0]).toBe("/Users/u/Library/Application Support/Code/User/mcp.json");
    expect(vscodeUserMcpPaths({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")[0]).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\Code\\User\\mcp.json",
    );
  });
});

describe("server names from URLs", () => {
  it("never throws and picks a readable name", async () => {
    const { hostLabel } = await import("../src/mcp/config");
    expect(hostLabel("https://mcp.github.com/mcp")).toBe("github");
    expect(hostLabel("http://localhost:3000/mcp")).toBe("local");
    expect(hostLabel("http://127.0.0.1:8080/mcp")).toBe("server");
    expect(hostLabel("http://")).toBe("server");
  });
});
