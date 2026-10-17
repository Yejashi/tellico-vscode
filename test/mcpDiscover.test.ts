import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixConfig, lintConfig, listServers } from "../src/mcp/config";
import { codexServers, discover, DiscoverOptions } from "../src/mcp/discover";

describe("config check", () => {
  // The shape that started this: v2 layout with the v1 "enabled" key.
  const users = `{
  // my servers
  "mcp": {
    "servers": {
      "black-hat-tomes": { "type": "local", "command": ["/x/tomes"], "enabled": false },
      "bookfusion": { "type": "local", "command": ["node", "/x/cli.js"], "enabled": false },
      "fine": { "type": "local", "command": ["fine"], "disabled": true }
    }
  }
}`;

  it("flags enabled under mcp.servers and fixes it to disabled", () => {
    expect(lintConfig(users).map((i) => i.name)).toEqual(["black-hat-tomes", "bookfusion"]);
    expect(lintConfig(users)[0].problem).toMatch(/starts anyway/);
    const fixed = fixConfig(users);
    expect(lintConfig(fixed)).toEqual([]);
    expect(listServers(fixed).map((s) => [s.name, (s.entry as any).disabled, "enabled" in (s.entry as any)])).toEqual([
      ["black-hat-tomes", true, false],
      ["bookfusion", true, false],
      ["fine", true, false],
    ]);
    expect(fixed).toContain("// my servers");
  });

  it("fixes the shapes other clients use", () => {
    const text = JSON.stringify({
      mcp: {
        servers: {
          claude: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "{env:TOKEN}" } },
          str: { type: "local", command: "uvx mcp-server-time --local" },
          vscode: { type: "stdio", command: ["node", "a.js"] },
          http: { type: "http", url: "https://x/mcp" },
        },
      },
    });
    expect(lintConfig(text).map((i) => i.name)).toEqual(["claude", "str", "vscode", "http"]);
    const entries = Object.fromEntries(listServers(fixConfig(text)).map((s) => [s.name, s.entry]));
    expect(entries.claude).toEqual({ type: "local", command: ["npx", "-y", "srv"], environment: { TOKEN: "{env:TOKEN}" } });
    expect(entries.str).toEqual({ type: "local", command: ["uvx", "mcp-server-time", "--local"] });
    expect(entries.vscode).toEqual({ type: "local", command: ["node", "a.js"] });
    expect(entries.http).toEqual({ type: "remote", url: "https://x/mcp" });
  });

  it("leaves the OpenCode 1 layout's enabled alone and fixes one server on request", () => {
    expect(lintConfig(JSON.stringify({ mcp: { old: { type: "local", command: ["x"], enabled: false } } }))).toEqual([]);
    const both = JSON.stringify({ mcp: { servers: { a: { type: "local", command: ["a"], enabled: false }, b: { type: "local", command: ["b"], enabled: false } } } });
    expect(lintConfig(fixConfig(both, "a")).map((i) => i.name)).toEqual(["b"]);
  });
});

describe("discovering servers on this machine", () => {
  const home = mkdtempSync(join(tmpdir(), "tellico-disc-"));
  const exe = (p: string) => (writeFileSync(p, "#!/bin/sh\n"), chmodSync(p, 0o755));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, "bin"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secret" } } }, projects: { [join(home, "p")]: { mcpServers: { local: { type: "http", url: "http://127.0.0.1:9/mcp" } } } } }),
  );
  writeFileSync(join(home, ".cursor", "mcp.json"), `{ "mcpServers": { "off": { "command": "x", "disabled": true }, // comment\n "dup": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }, } }`);
  writeFileSync(join(home, ".codex", "config.toml"), `model = "o"\n[mcp_servers.time]\ncommand = "uvx"\nargs = [\n  "mcp-server-time",\n]\n[mcp_servers.time.env]\nTZ = "UTC"\n[projects."/"]\ntrust_level = "trusted"\n`);
  exe(join(home, "bin", "libgen-mcp"));
  exe(join(home, "bin", "mcp-inspector"));
  writeFileSync(join(home, "bin", "notes-mcp"), "not executable");
  const repo = join(home, "repos", "mcp-servers");
  for (const [dir, built] of [["servers/books", true], ["servers/unbuilt", false], ["templates/server", true]] as const) {
    mkdirSync(join(repo, dir, "dist"), { recursive: true });
    writeFileSync(join(repo, dir, "package.json"), JSON.stringify({ name: `${dir.split("/").pop()}-mcp`, bin: { x: "dist/cli.js" }, dependencies: { "@modelcontextprotocol/sdk": "^1" } }));
    if (built) writeFileSync(join(repo, dir, "dist", "cli.js"), "");
  }
  const opts: DiscoverOptions = { home, pathDirs: [join(home, "bin")], searchRoots: [join(home, "repos")], node: "/usr/bin/node", platform: "linux", xdgConfig: join(home, ".config") };
  const found = discover(opts);
  const byName = Object.fromEntries(found.map((d) => [d.name, d]));

  it("reads other clients, keeps env as references, skips disabled ones and duplicates", () => {
    expect(byName.github).toMatchObject({
      source: "Claude Code",
      entry: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github"], environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}" } },
      envKeys: ["GITHUB_TOKEN"],
      secrets: { GITHUB_TOKEN: "ghp_secret" },
    });
    // The value never sits in an entry; only in `secrets`, for an explicit copy.
    expect(JSON.stringify(found.map((d) => d.entry))).not.toContain("ghp_secret");
    expect(byName.local).toMatchObject({ source: "Claude Code (~/p)", entry: { type: "remote", url: "http://127.0.0.1:9/mcp" } });
    expect(byName.off).toBeUndefined();
    expect(byName.dup).toBeUndefined();
    expect(byName.time).toMatchObject({ source: "Codex", entry: { command: ["uvx", "mcp-server-time"], environment: { TZ: "{env:TZ}" } }, secrets: { TZ: "UTC" } });
  });

  it("finds installed commands and built SDK packages, not tools or templates", () => {
    expect(byName["libgen-mcp"]).toMatchObject({ entry: { command: [join(home, "bin", "libgen-mcp")] }, source: "installed command (~/bin)" });
    expect(found.some((d) => /inspector|notes/.test(d.name))).toBe(false);
    expect(byName["books-mcp"]).toMatchObject({ entry: { command: ["/usr/bin/node", join(repo, "servers/books/dist/cli.js")] }, source: "~/repos/mcp-servers/servers/books" });
    expect(byName["unbuilt-mcp"]).toBeUndefined();
    expect(byName["server-mcp"]).toBeUndefined();
  });

  it("parses the Codex TOML it needs", () => {
    expect(codexServers(`[mcp_servers."my srv"]\ncommand = 'srv' # comment\nenv = { A = "1", B = 'two' }\nurl = "u"`)).toEqual({ "my srv": { command: "srv", env: { A: "1", B: "two" }, url: "u" } });
  });
});
