// Starts and supervises `opencode-tellico serve` for one workspace folder.
//
// The launcher owns everything Tellico-specific (lead node, runtime config,
// plugins, Magic Context, websearch, background subagents), so this only
// chooses a port and a password and passes the user's settings as the same
// flags and variables a terminal user would.

import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Api, Connection } from "./api";

export interface LaunchSettings {
  launcherPath: string;
  leadNode: "auto" | "0" | "1";
  magicContext: boolean;
  backgroundSubagents: boolean;
}

export type ServerState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "ready"; conn: Connection }
  | { kind: "failed"; message: string };

export interface ManagerEvents {
  onState(state: ServerState): void;
  onLog(line: string): void;
}

const READY_TIMEOUT_MS = 90_000;

/**
 * Runs the server under a POSIX-sh watchdog so it cannot outlive VS Code.
 * Its stdin is a pipe from the extension host; when the host goes away for
 * any reason, even SIGKILL, the pipe closes, `read` returns and the server is
 * killed. TERM/INT on the shell (our own stop()) are forwarded too. Commands
 * started with & in a non-interactive shell get /dev/null as stdin, hence the
 * explicit fd 3.
 */
export const WATCHDOG = [
  'exec 3<&0',
  '"$@" & pid=$!',
  'trap \'kill "$pid" 2>/dev/null\' TERM INT HUP',
  '( read _ <&3; kill "$pid" 2>/dev/null ) & watch=$!',
  'wait "$pid"; status=$?',
  'kill "$watch" 2>/dev/null',
  'exit "$status"',
].join("\n");

export class ServerManager {
  private proc?: ChildProcess;
  private state: ServerState = { kind: "stopped" };
  private restarts = 0;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly settings: () => LaunchSettings,
    private readonly events: ManagerEvents,
  ) {}

  get current(): ServerState {
    return this.state;
  }

  async start(): Promise<Connection> {
    this.stop();
    this.disposed = false;
    this.set({ kind: "starting" });
    const s = this.settings();
    const launcher = resolveLauncher(s.launcherPath);
    if (!launcher) {
      const msg =
        `Cannot find ${s.launcherPath}. Install the client from tellico-agentic-setup ` +
        `(./install.sh, or ./install.sh --gateway with an API key), or set tellico.launcherPath.`;
      this.set({ kind: "failed", message: msg });
      throw new Error(msg);
    }

    const port = await freePort();
    const password = randomBytes(24).toString("hex");
    const args: string[] = [];
    if (s.leadNode !== "auto") args.push(s.leadNode);
    if (!s.magicContext) args.push("--no-magic-context");
    args.push("serve", "--hostname", "127.0.0.1", "--port", String(port));

    const env = { ...process.env };
    env.PATH = [join(homedir(), ".local", "bin"), env.PATH ?? ""].join(delimiter);
    env.OPENCODE_PASSWORD = password;
    env.TELLICO_BACKGROUND_SUBAGENTS = s.backgroundSubagents ? "1" : "0";
    // A stale value inherited from the shell VS Code started in must not win
    // over the user's explicit setting.
    if (s.leadNode !== "auto") env.TELLICO_LEAD_NODE = s.leadNode;
    else delete env.TELLICO_LEAD_NODE;
    env.OPENCODE_CALLER = "vscode";

    this.events.onLog(`$ ${launcher} ${args.join(" ")}   (cwd ${this.directory})`);
    const proc = spawn("/bin/sh", ["-c", WATCHDOG, "tellico-serve", launcher, ...args], {
      cwd: this.directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    const conn: Connection = { baseUrl: `http://127.0.0.1:${port}`, password, directory: this.directory };
    const api = new Api(conn);

    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      let tail = "";
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        // A start that was superseded by a newer one only rejects its caller.
        if (this.proc === undefined || this.proc === proc) this.set({ kind: "failed", message });
        reject(new Error(message));
      };
      const onData = (buf: Buffer) => {
        const text = buf.toString();
        tail = (tail + text).slice(-2000);
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.events.onLog(line);
      };
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onData);
      proc.on("error", (err) => fail(`Could not start ${launcher}: ${err.message}`));
      proc.on("exit", (code, signal) => {
        this.events.onLog(`server exited (code ${code ?? "-"}, signal ${signal ?? "-"})`);
        // A process replaced by a restart must not drive the current state.
        const current = this.proc === proc;
        if (current) this.proc = undefined;
        if (!settled) {
          // A launcher installed before serve mode passes "serve" through to
          // opencode behind --standalone, which opencode then rejects.
          if (/Unrecognized flag: --standalone in command opencode serve/.test(tail)) {
            fail(
              "The installed opencode-tellico predates serve mode. Update the client: " +
                "run ./install.sh --no-start in your tellico-agentic-setup checkout, then retry.",
            );
            return;
          }
          fail(`opencode-tellico exited before it was ready (code ${code}).\n${tail.trim().split("\n").slice(-6).join("\n")}`);
          return;
        }
        if (current && !this.disposed && this.state.kind === "ready") this.crashed();
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      const poll = async () => {
        if (settled) return;
        if (Date.now() > deadline) {
          proc.kill();
          fail(`opencode-tellico did not become ready within ${READY_TIMEOUT_MS / 1000}s.`);
          return;
        }
        // Agents load lazily per directory; the Tellico ones appearing is the
        // signal that the installed config was read, not just that HTTP is up.
        if (await api.ready()) {
          settled = true;
          this.restarts = 0;
          this.set({ kind: "ready", conn });
          resolve(conn);
          return;
        }
        setTimeout(poll, 400);
      };
      setTimeout(poll, 300);
    });
  }

  private crashed() {
    if (this.restarts >= 3) {
      this.set({ kind: "failed", message: "The Tellico server keeps exiting. See Tellico: Show Server Logs." });
      return;
    }
    this.restarts++;
    const delay = 1000 * 2 ** this.restarts;
    this.events.onLog(`restarting in ${delay / 1000}s`);
    this.set({ kind: "starting" });
    setTimeout(() => {
      if (!this.disposed) this.start().catch(() => {});
    }, delay);
  }

  stop() {
    this.disposed = true;
    const p = this.proc;
    this.proc = undefined;
    if (p && p.exitCode === null) {
      p.kill("SIGTERM");
      setTimeout(() => {
        if (p.exitCode === null) p.kill("SIGKILL");
      }, 3000).unref();
    }
    if (this.state.kind !== "failed") this.set({ kind: "stopped" });
  }

  private set(state: ServerState) {
    this.state = state;
    this.events.onState(state);
  }
}

export function resolveLauncher(setting: string): string | undefined {
  const expanded = setting.replace(/^~(?=\/|$)/, homedir());
  if (isAbsolute(expanded)) return existsSync(expanded) ? expanded : undefined;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  for (const d of dirs) {
    if (!d) continue;
    const candidate = join(d, expanded);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}
