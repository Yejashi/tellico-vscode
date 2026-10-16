import { describe, expect, it } from "vitest";
import { explainExit } from "../src/server/manager";

// The texts are the launcher's own (tellico-agentic-setup bin/ and lib/).
describe("launcher failures", () => {
  const cases: [string, RegExp][] = [
    ["opencode-tellico: no gateway API key in /home/u/.config/tellico-qwen/api-key.gateway", /Set Gateway API Key/],
    ["models               unauthorized", /rejected the API key/],
    ["models               no_allocation", /no Tellico allocation/],
    ["Tunnel is running, but one or both model servers are unavailable.\nCheck the allocation with: ssh tellico qwen38-status", /qwen38-status/],
    ["bbogale@tellico: Permission denied (publickey).", /SSH to the cluster failed: bbogale@tellico: Permission denied \(publickey\)\./],
    ["opencode-tellico: unknown connection 'x'\nUse tunnel or gateway.", /no --connection yet/],
    ["Error: Unrecognized flag: --standalone in command opencode serve", /predates serve mode/],
    ["opencode-tellico: opencode is not installed or not on PATH", /Install OpenCode 2/],
    ["opencode-tellico: Magic Context needs /x/cortexkit/magic-context.jsonc", /tellico\.magicContext/],
    ["opencode-tellico: missing /x/opencode.json\nRerun install.sh from the tellico-agentic-setup repository.", /install is incomplete/],
    ["opencode-tellico: unknown TELLICO_WEBSEARCH 'bing'", /rejected a setting: unknown TELLICO_WEBSEARCH 'bing'/],
  ];
  for (const [tail, want] of cases) it(tail.split("\n")[0], () => expect(explainExit(tail, 1)).toMatch(want));

  it("falls back to the last lines of output", () => {
    expect(explainExit("a\nb\nsomething odd", 3)).toBe("opencode-tellico exited before it was ready (code 3).\na\nb\nsomething odd");
  });
});
