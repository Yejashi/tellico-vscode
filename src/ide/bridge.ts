// Runs the IDE MCP server for this window and registers it with the
// OpenCode server as the `vscode` MCP server, at runtime: nothing is written
// to any config file, and the token never leaves this process and the
// loopback connection. Re-registered after every (re)connect, because a
// location reload drops servers added at runtime.

import * as vscode from "vscode";
import { Api } from "../server/api";
import { IdeMcpServer } from "./mcpServer";
import { ideTools } from "./tools";

export const IDE_SERVER = "vscode";

export class IdeBridge implements vscode.Disposable {
  private server?: IdeMcpServer;
  private endpoint?: Promise<{ url: string; token: string }>;

  constructor(private readonly root: () => string | undefined, private readonly log: (line: string) => void) {}

  get running(): boolean {
    return Boolean(this.server);
  }

  private start(): Promise<{ url: string; token: string }> {
    if (!this.endpoint) {
      this.server = new IdeMcpServer(ideTools(this.root), {
        name: "vscode",
        version: "1",
        instructions: "VS Code, where the user is working. Ask it for diagnostics after editing, instead of guessing whether the code compiles.",
      });
      this.endpoint = this.server.start();
      this.endpoint.then(({ url }) => this.log(`IDE MCP server on ${url}`)).catch(() => {});
    }
    return this.endpoint;
  }

  /** Starts the server if needed and (re)registers it; never throws. */
  async register(api: Api): Promise<void> {
    try {
      const { url, token } = await this.start();
      await api.addMcp(IDE_SERVER, {
        type: "remote",
        url,
        headers: { Authorization: `Bearer ${token}` },
        // Direct tools, not hidden behind Code Mode's execute tool; and a bad
        // token must never start an OAuth discovery.
        codemode: false,
        oauth: false,
      });
    } catch (err: any) {
      this.log(`IDE MCP server not registered: ${String(err?.message ?? err)}`);
    }
  }

  async unregister(api?: Api) {
    await api?.removeMcp(IDE_SERVER).catch(() => {});
    await this.stop();
  }

  private async stop() {
    const s = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    await s?.stop().catch(() => {});
  }

  dispose() {
    void this.stop();
  }
}
