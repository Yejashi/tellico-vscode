import { spawn, execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WATCHDOG } from "../src/server/manager";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts `sleep 300` under the watchdog and returns the shell and the sleep's pid. */
async function start() {
  const sh = spawn("/bin/sh", ["-c", WATCHDOG, "tellico-serve", "sleep", "300"], { stdio: ["pipe", "ignore", "ignore"] });
  let child = 0;
  for (let i = 0; i < 50 && !child; i++) {
    await sleep(50);
    try {
      child = Number(execFileSync("pgrep", ["-P", String(sh.pid), "sleep"], { encoding: "utf8" }).trim().split("\n")[0]);
    } catch {
      child = 0;
    }
  }
  expect(child).toBeGreaterThan(0);
  return { sh, child };
}

describe("server watchdog", () => {
  it("kills the server when the extension host's pipe closes", async () => {
    const { child } = await start().then((r) => (r.sh.stdin!.end(), r));
    for (let i = 0; i < 40 && alive(child); i++) await sleep(50);
    expect(alive(child)).toBe(false);
  });

  it("forwards SIGTERM from stop() to the server", async () => {
    const { sh, child } = await start();
    sh.kill("SIGTERM");
    for (let i = 0; i < 40 && alive(child); i++) await sleep(50);
    expect(alive(child)).toBe(false);
  });

  it("exits with the server's status when the server ends by itself", async () => {
    const sh = spawn("/bin/sh", ["-c", WATCHDOG, "tellico-serve", "sh", "-c", "exit 7"], { stdio: ["pipe", "ignore", "ignore"] });
    const code = await new Promise((r) => sh.on("exit", r));
    expect(code).toBe(7);
  });
});
