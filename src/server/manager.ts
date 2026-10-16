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
  /** "installed" uses whatever install.sh set up; otherwise this launch only. */
  connection: "installed" | "tunnel" | "gateway";
  gatewayUrl: string;
  leadNode: "auto" | "0" | "1";
  magicContext: boolean;
  backgroundSubagents: boolean;
  /** TELLICO_WEBSEARCH; "default" leaves the launcher's choice. */
  websearch: string;
  /** TELLICO_STEPS; 0 leaves the launcher's default. */
  steps: number;
  /** TELLICO_LOOP_GUARD=0 when false. */
  loopGuard: boolean;
  /** --remote-control / --no-remote-control; "installed" leaves client.env's choice. */
  remoteControl: "installed" | "on" | "off";
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
    if (s.remoteControl !== "installed") args.push(s.remoteControl === "on" ? "--remote-control" : "--no-remote-control");
    args.push("serve", "--hostname", "127.0.0.1", "--port", String(port));

    const env = { ...process.env };
    env.PATH = [join(homedir(), ".local", "bin"), env.PATH ?? ""].join(delimiter);
    env.OPENCODE_PASSWORD = password;
    env.TELLICO_BACKGROUND_SUBAGENTS = s.backgroundSubagents ? "1" : "0";
    // Explicit either way, so a value inherited from VS Code's own shell
    // cannot silently pick the connection.
    delete env.TELLICO_CONNECTION;
    delete env.TELLICO_CONNECTION_GATEWAY_URL;
    if (s.connection !== "installed") env.TELLICO_CONNECTION = s.connection;
    if (s.gatewayUrl.trim()) env.TELLICO_CONNECTION_GATEWAY_URL = s.gatewayUrl.trim().replace(/\/+$/, "");
    // A stale value inherited from the shell VS Code started in must not win
    // over the user's explicit setting.
    if (s.leadNode !== "auto") env.TELLICO_LEAD_NODE = s.leadNode;
    else delete env.TELLICO_LEAD_NODE;
    if (s.websearch && s.websearch !== "default") env.TELLICO_WEBSEARCH = s.websearch;
    if (s.steps > 0) env.TELLICO_STEPS = String(Math.floor(s.steps));
    if (!s.loopGuard) env.TELLICO_LOOP_GUARD = "0";
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
          fail(explainExit(tail, code));
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

const UPDATE = "run ./install.sh --no-start in your tellico-agentic-setup checkout, then retry";

/**
 * Turns the launcher's last output before it exited into what to do about it.
 * The patterns are the launcher's own messages (bin/opencode-tellico,
 * bin/tellico-qwen-tunnel, lib/checks.sh in tellico-agentic-setup).
 */
export function explainExit(tail: string, code: number | null): string {
  const has = (re: RegExp) => re.test(tail);
  const line = (re: RegExp) => tail.split("\n").find((l) => re.test(l))?.replace(/^opencode-tellico:\s*/, "").trim();
  if (has(/no gateway API key/)) return 'No gateway API key on this device yet. Run "Tellico: Set Gateway API Key", or switch the connection to SSH.';
  if (has(/models\s+unauthorized|Invalid API key/)) return 'The gateway rejected the API key. Set it again with "Tellico: Set Gateway API Key".';
  if (has(/no gateway URL/)) return "No gateway URL is configured for this device. Set tellico.gatewayUrl, or reinstall the client with ./install.sh --gateway.";
  if (has(/models\s+no_allocation|Slurm allocation has probably ended/))
    return "The gateway is up, but no Tellico allocation is running on the cluster. Ask the service owner to submit another, or try again later.";
  if (has(/models\s+unreachable/)) return "The gateway is unreachable from this device. Check your network, or switch the connection to SSH.";
  if (has(/one or both model servers are unavailable/))
    return "The SSH tunnel is up, but a Tellico model server is not answering: the allocation may still be loading or may have ended. Check with: ssh tellico qwen38-status";
  if (has(/Permission denied \(publickey|Host key verification failed|Could not resolve hostname|Connection timed out|Connection refused|No route to host/)) {
    const why = line(/Permission denied|Host key verification|Could not resolve|timed out|refused|No route/);
    return `SSH to the cluster failed${why ? `: ${why}` : ""}. Check your SSH key and network (VPN), or switch the connection to the API gateway.`;
  }
  if (has(/unknown connection|--connection requires/)) return `The installed opencode-tellico has no --connection yet. Update the client: ${UPDATE}.`;
  if (has(/Unrecognized flag: --standalone in command opencode serve/)) return `The installed opencode-tellico predates serve mode. Update the client: ${UPDATE}.`;
  if (has(/opencode is not installed or not on PATH/)) return "OpenCode is not installed, or not on the PATH VS Code sees. Install OpenCode 2 (opencode --version should say 2.x).";
  if (has(/Magic Context needs/)) return `Magic Context is not installed for the client. Reinstall it (${UPDATE}), or turn off tellico.magicContext.`;
  if (has(/Rerun install\.sh|missing .*\/(opencode\.json|checks\.sh)/)) return `The Tellico client install is incomplete: ${UPDATE}.`;
  const bad = line(/unknown TELLICO_WEBSEARCH|must be (0 or 1|a positive number|tunnel or gateway)|unknown thinking level/);
  if (bad) return `opencode-tellico rejected a setting: ${bad}`;
  return `opencode-tellico exited before it was ready (code ${code}).\n${tail.trim().split("\n").slice(-6).join("\n")}`;
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
