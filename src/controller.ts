// One controller per window: owns the server process, the API client, the
// event stream and the store, and fans session updates out to every open chat
// view (the sidebar and any editor tabs). Each view shows one session.

import * as vscode from "vscode";
import { AgentInfo, Api, Connection, Delivery } from "./server/api";
import { EventStream } from "./server/events";
import { LaunchSettings, ServerManager, ServerState } from "./server/manager";
import { ServerEvent, Store } from "./state/reducer";
import { Mode, ModelRef, parseTellicoAgent, SessionView, tellicoAgent, ThinkLevel } from "../shared/model";
import { Attachment, EditorContext, HostToWebview, McpConfigIssues, McpServerView, Prefs, ServerStatus, SessionSummary, WebviewToHost } from "../shared/protocol";
import { reversePatch } from "./diff/patch";
import { ConnectionSetting, effectiveConnection, hasKey, installedMode, writeGatewayKey } from "./server/connection";
import { BEFORE_SCHEME, BeforeContentProvider } from "./diff/beforeProvider";
import { attachable, buildPromptFiles } from "./prompt";
import { IDE_SERVER, IdeBridge } from "./ide/bridge";
import { Attention, NotifyWhen } from "./attention";
import { McpManager } from "./mcp/manage";

/** What the controller needs from a webview, sidebar or tab alike. */
export interface ChatView {
  readonly id: string;
  sessionID?: string;
  post(msg: HostToWebview): void;
  reveal(): void;
  /** Bookkeeping for incremental session updates. */
  sent: { length: number; status?: string; key?: string };
}

const FLUSH_MS = 33;

export class Controller implements vscode.Disposable {
  private readonly log: vscode.LogOutputChannel;
  private manager?: ServerManager;
  private api?: Api;
  private stream?: EventStream;
  private readonly store = new Store();
  private readonly views = new Set<ChatView>();
  private serverStatus: ServerStatus = { kind: "stopped" };
  private agents: AgentInfo[] = [];
  private commands: { name: string; description?: string }[] = [];
  private mcpServers: McpServerView[] = [];
  private mcpIssues: McpConfigIssues[] = [];
  private prefs: Prefs;
  private context: EditorContext = {};
  private dirty = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private refetchTimer?: NodeJS.Timeout;
  private starting?: Promise<Connection | undefined>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ide: IdeBridge;
  private readonly attention: Attention;
  private readonly mcp: McpManager;
  private readonly waitingEmitter = new vscode.EventEmitter<number>();
  /** Pending permission requests and questions, for the view badge. */
  readonly onWaiting = this.waitingEmitter.event;
  readonly statusItem: vscode.StatusBarItem;

  constructor(private readonly ext: vscode.ExtensionContext, private readonly before: BeforeContentProvider) {
    this.log = vscode.window.createOutputChannel("Tellico", { log: true });
    const cfg = vscode.workspace.getConfiguration("tellico");
    this.prefs = {
      mode: cfg.get<Mode>("defaultMode", "build"),
      node: 0,
      think: cfg.get<ThinkLevel>("defaultThink", "medium"),
      attachActiveEditor: cfg.get<boolean>("attachActiveEditor", true),
      showReasoning: cfg.get<boolean>("showReasoning", false),
      smoothStreaming: cfg.get<boolean>("smoothStreaming", true),
      magicContext: cfg.get<boolean>("magicContext", true),
      root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    };
    this.refreshConnectionPrefs();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = "tellico.focus";
    this.statusItem.show();
    this.ide = new IdeBridge(() => this.directory, (l) => this.log.info(l));
    this.attention = new Attention(
      () => vscode.workspace.getConfiguration("tellico").get<NotifyWhen>("notifications", "unfocused"),
      (id) => void this.openInPrimary(id),
    );
    this.mcp = new McpManager(() => this.directory, (l) => this.log.info(l));
    this.renderStatus();

    this.disposables.push(
      this.log,
      this.statusItem,
      this.ide,
      this.waitingEmitter,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateContext()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (["showReasoning", "attachActiveEditor", "smoothStreaming"].some((k) => e.affectsConfiguration(`tellico.${k}`))) {
          const c = vscode.workspace.getConfiguration("tellico");
          this.prefs.showReasoning = c.get("showReasoning", false);
          this.prefs.smoothStreaming = c.get("smoothStreaming", true);
          this.prefs.attachActiveEditor = c.get("attachActiveEditor", true);
          this.broadcast({ type: "prefs", prefs: this.prefs });
        }
        if (e.affectsConfiguration("tellico.ideTools") && this.api) {
          if (this.ideToolsEnabled) void this.ide.register(this.api).then(() => this.refreshMcp());
          else void this.ide.unregister(this.api).then(() => this.refreshMcp());
        }
        if (
          ["launcherPath", "leadNode", "magicContext", "backgroundSubagents", "connection", "gatewayUrl", "websearch", "steps", "loopGuard", "remoteControl"].some((k) =>
            e.affectsConfiguration(`tellico.${k}`),
          )
        ) {
          this.prefs.magicContext = vscode.workspace.getConfiguration("tellico").get("magicContext", true);
          // A connection change made from the chat restarts by itself.
          if (this.restartingForConnection) return;
          void vscode.window.showInformationMessage("Tellico server settings changed.", "Restart Server").then((pick) => pick && this.restart());
        }
      }),
    );
    this.updateContext();
  }

  get directory(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private get ideToolsEnabled(): boolean {
    return vscode.workspace.getConfiguration("tellico").get<boolean>("ideTools", true);
  }

  // ---------- server lifecycle ----------

  ensureServer(): Promise<Connection | undefined> {
    if (this.serverStatus.kind === "ready" && this.api) return Promise.resolve(undefined);
    if (this.starting) return this.starting;
    const dir = this.directory;
    if (!dir) {
      this.setServer({ kind: "failed", message: "Open a folder to use Tellico: the agents work inside a workspace." });
      return Promise.resolve(undefined);
    }
    this.manager ??= new ServerManager(dir, () => this.launchSettings(), {
      onState: (s) => this.onManagerState(s),
      onLog: (line) => this.log.info(line),
    });
    // The manager reports "starting" synchronously, before this.starting is
    // set: without the flag that looks like a crash restart and connects twice.
    this.launching = true;
    const started = this.manager.start();
    this.launching = false;
    this.starting = started
      .then(async (conn) => {
        await this.connect(conn);
        return conn;
      })
      .catch((err) => {
        this.log.error(String(err?.message ?? err));
        return undefined;
      })
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  async restart() {
    this.stream?.stop();
    this.stream = undefined;
    this.api = undefined;
    this.manager?.stop();
    this.manager = undefined;
    await this.ensureServer();
  }

  private launchSettings(): LaunchSettings {
    const c = vscode.workspace.getConfiguration("tellico");
    return {
      launcherPath: c.get("launcherPath", "opencode-tellico"),
      connection: c.get<ConnectionSetting>("connection", "installed"),
      gatewayUrl: c.get<string>("gatewayUrl", ""),
      leadNode: c.get("leadNode", "auto") as LaunchSettings["leadNode"],
      magicContext: c.get("magicContext", true),
      backgroundSubagents: c.get("backgroundSubagents", false),
      websearch: c.get<string>("websearch", "default"),
      steps: c.get<number>("steps", 0),
      loopGuard: c.get<boolean>("loopGuard", true),
      remoteControl: c.get<"installed" | "on" | "off">("remoteControl", "installed"),
    };
  }

  private onManagerState(s: ServerState) {
    if (s.kind === "ready") return; // reported after connect() has loaded agents
    if (s.kind === "starting" && this.serverStatus.kind === "ready") {
      this.stream?.stop();
      this.api = undefined;
    }
    this.setServer(s.kind === "failed" ? { kind: "failed", message: s.message } : { kind: s.kind });
    if (s.kind === "starting" && !this.starting && !this.launching && this.manager) {
      // An automatic restart after a crash: reconnect once it is up.
      this.starting = new Promise((resolve) => {
        const check = setInterval(() => {
          const cur = this.manager?.current;
          if (cur?.kind === "ready") {
            clearInterval(check);
            void this.connect(cur.conn).then(() => resolve(cur.conn));
          } else if (!cur || cur.kind === "failed" || cur.kind === "stopped") {
            clearInterval(check);
            resolve(undefined);
          }
        }, 250);
      }).finally(() => (this.starting = undefined)) as Promise<Connection | undefined>;
    }
  }

  private async connect(conn: Connection) {
    const api = new Api(conn);
    this.api = api;
    this.agents = await api.agents();
    this.commands = await this.loadCommands(api);
    const model = await api.defaultModel().catch(() => ({}) as Awaited<ReturnType<Api["defaultModel"]>>);
    this.prefs.node = this.configuredNode() ?? model.node ?? 0;
    this.prefs.contextLimit = model.limits?.context;
    this.prefs.images = model.images;
    this.prefs.branch = (await api.vcs().catch(() => undefined))?.branch;
    this.stream?.stop();
    this.stream = new EventStream(api, {
      onEvent: (ev) => this.onEvent(api, ev),
      onConnected: (first) => {
        this.log.info(first ? "event stream connected" : "event stream reconnected; resyncing open sessions");
        if (!first) void this.resyncAll();
      },
      onDisconnected: (err) => this.log.warn(`event stream dropped: ${String((err as any)?.message ?? err)}`),
    });
    this.stream.start();
    this.setServer({ kind: "ready" });
    this.broadcast({ type: "prefs", prefs: this.prefs });
    this.broadcast({ type: "commands", commands: this.commands });
    if (this.ideToolsEnabled) await this.ide.register(api);
    void this.refreshMcp();
    await this.resyncAll();
  }

  private async loadCommands(api: Api) {
    return (await api.commands().catch(() => [])).filter((c) => !c.name.startsWith("think-"));
  }

  private onEvent(api: Api, ev: ServerEvent) {
    const changed = this.store.apply(ev);
    for (const id of changed) this.markDirty(id);
    const sid = ev.data?.sessionID as string | undefined;
    // When a turn ends or a rewind moves, take the authoritative changed-file
    // list from the server: it includes workers' edits and shell side effects.
    if (/^session\.execution\.(succeeded|interrupted|failed)$|^session\.revert\.(staged|cleared)$/.test(ev.type)) {
      const root = sid ? this.store.sessions.get(sid) : undefined;
      const lead = root?.parentID ?? root?.id;
      if (lead && [...this.views].some((v) => v.sessionID === lead)) void this.refreshChanges(lead);
      if (sid && ev.type.startsWith("session.execution.")) this.markViewed(sid);
    }
    if (ev.type === "session.revert.committed" && sid) void this.loadSession(sid).then(() => this.resend(sid)).catch(() => {});
    // Config edits (by hand or by Add server) change both the servers and what the check finds.
    if (ev.type.startsWith("mcp.") || ev.type === "config.updated") this.debounceRefetch();
    if (ev.type === "command.updated") void this.loadCommands(api).then((c) => ((this.commands = c), this.broadcast({ type: "commands", commands: c })));
    if (ev.type === "vcs.branch.updated") void api.vcs().then((v) => ((this.prefs.branch = v?.branch), this.broadcast({ type: "prefs", prefs: this.prefs })));
    // A location reload drops runtime MCP servers and cancels pending asks.
    if (ev.type === "location.shutdown") {
      setTimeout(() => {
        if (this.api !== api) return;
        if (this.ideToolsEnabled) void this.ide.register(api);
        void this.resyncAll();
      }, 1500);
    }
  }

  private debounceRefetch() {
    clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => void this.refreshMcp(), 250);
  }

  private configuredNode(): 0 | 1 | undefined {
    const v = vscode.workspace.getConfiguration("tellico").get<string>("leadNode", "auto");
    return v === "0" ? 0 : v === "1" ? 1 : undefined;
  }

  private restartingForConnection = false;
  private launching = false;

  private refreshConnectionPrefs() {
    const setting = vscode.workspace.getConfiguration("tellico").get<ConnectionSetting>("connection", "installed");
    this.prefs.connectionSetting = setting;
    this.prefs.connection = effectiveConnection(setting);
  }

  /** Switches SSH/gateway for this device and restarts the server on it. */
  async setConnection(setting: ConnectionSetting) {
    const target = setting === "installed" ? installedMode() : setting;
    if (target === "gateway" && !hasKey("gateway")) {
      const ok = await this.promptGatewayKey();
      if (!ok) return;
    }
    this.restartingForConnection = true;
    try {
      await vscode.workspace.getConfiguration("tellico").update("connection", setting, vscode.ConfigurationTarget.Global);
    } finally {
      this.restartingForConnection = false;
    }
    this.refreshConnectionPrefs();
    this.broadcast({ type: "prefs", prefs: this.prefs });
    await this.restart();
  }

  /** Asks for the gateway key and stores it where the launcher reads it. */
  async promptGatewayKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: "Tellico gateway API key",
      prompt: "The per-user key from whoever runs the Tellico gateway. Stored in ~/.config/tellico-qwen with mode 600.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Paste the key"),
    });
    if (!key) return false;
    const path = writeGatewayKey(key);
    this.log.info(`gateway key stored in ${path}`);
    void vscode.window.showInformationMessage("Gateway API key saved.");
    return true;
  }

  async pickConnection() {
    const installed = installedMode();
    const items: (vscode.QuickPickItem & { value: ConnectionSetting })[] = [
      { value: "tunnel", label: "$(remote) SSH tunnel", description: installed === "tunnel" ? "installed" : "", detail: "Your cluster account; the launcher brings the SSH tunnel up." },
      { value: "gateway", label: "$(cloud) API gateway", description: installed === "gateway" ? "installed" : "", detail: hasKey("gateway") ? "Per-user API key, no SSH." : "Per-user API key, no SSH. You will be asked for the key." },
      { value: "installed", label: "$(settings-gear) As installed", description: installed, detail: "Whatever ./install.sh set up on this device." },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: "Reach Tellico through…" });
    if (pick) await this.setConnection(pick.value);
  }

  private setServer(status: ServerStatus) {
    this.serverStatus = status;
    this.broadcast({ type: "server", status });
    this.renderStatus();
  }

  private renderStatus() {
    const s = this.serverStatus;
    const leads = [...this.store.sessions.values()].filter((x) => !x.parentID);
    const busy = leads.some((x) => x.status === "busy");
    const waiting = this.attention.waiting(this.store.sessions.values());
    const icon =
      s.kind === "ready" ? (waiting ? "$(bell-dot)" : busy ? "$(sync~spin)" : "$(hubot)") : s.kind === "starting" ? "$(loading~spin)" : s.kind === "failed" ? "$(error)" : "$(circle-slash)";
    const via = this.prefs.connection === "gateway" ? "gateway" : "SSH";
    this.statusItem.text = `${icon} Tellico${s.kind === "ready" ? (waiting ? " · needs you" : ` · ${this.prefs.mode} · node ${this.prefs.node} · ${via}`) : ""}`;
    this.statusItem.tooltip =
      s.kind === "failed" ? s.message : waiting ? `${waiting} question${waiting > 1 ? "s" : ""} waiting for an answer` : `Tellico server: ${s.kind}${busy ? " · working" : ""}`;
    this.statusItem.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : s.kind === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.statusItem.accessibilityInformation = { label: `Tellico: ${this.statusItem.tooltip}` };
    this.waitingEmitter.fire(waiting);
    if (busy !== this.busyContext) {
      this.busyContext = busy;
      void vscode.commands.executeCommand("setContext", "tellico.busy", busy);
    }
  }

  private busyContext?: boolean;

  // ---------- views ----------

  attach(view: ChatView): vscode.Disposable {
    this.views.add(view);
    return new vscode.Disposable(() => this.views.delete(view));
  }

  private broadcast(msg: HostToWebview) {
    for (const v of this.views) v.post(msg);
  }

  private initView(view: ChatView) {
    view.post({ type: "server", status: this.serverStatus });
    view.post({ type: "prefs", prefs: this.prefs });
    view.post({ type: "commands", commands: this.commands });
    view.post({ type: "context", context: this.context });
    view.post({ type: "mcp", servers: this.mcpServers, issues: this.mcpIssues });
    if (view.sessionID) this.sendSession(view, true);
    else view.post({ type: "noSession" });
  }

  private markDirty(id: string) {
    this.dirty.add(id);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    this.flushTimer = undefined;
    const ids = this.dirty;
    this.dirty = new Set();
    for (const v of this.views) if (v.sessionID && ids.has(v.sessionID)) this.sendSession(v, false);
    this.attention.update(
      [...ids].map((id) => this.store.sessions.get(id)).filter((s): s is SessionView => Boolean(s)),
      () => this.store.sessions.values(),
    );
    this.renderStatus();
  }

  private resend(id: string) {
    for (const v of this.views) if (v.sessionID === id) this.sendSession(v, true);
  }

  /** The sidebar reopens on its last session after a window reload. */
  private remember(view: ChatView) {
    if (view.id.startsWith("sidebar")) void this.ext.workspaceState.update("tellico.sidebarSession", view.sessionID);
  }

  get rememberedSidebarSession(): string | undefined {
    return this.ext.workspaceState.get<string>("tellico.sidebarSession");
  }

  private sendSession(view: ChatView, full: boolean) {
    const s = this.store.sessions.get(view.sessionID!);
    if (!s) return;
    if (full) this.remember(view);
    const { messages, ...own } = s;
    // A worker's permission requests and questions are answered from the
    // lead's view: the user is watching the lead, not the worker.
    const kids = s.children.map((c) => this.store.sessions.get(c.id)).filter((c): c is SessionView => Boolean(c));
    const meta = {
      ...own,
      permissions: [...own.permissions, ...kids.flatMap((c) => c.permissions)],
      forms: [...own.forms, ...kids.flatMap((c) => c.forms)],
    };
    // Everything but the transcript is small; send it every time. The
    // transcript is re-sent from the first message that can still change.
    const key = JSON.stringify([meta.status, meta.permissions.length, meta.forms.length, meta.children.length]);
    let from = 0;
    if (!full && view.sent.key === key && messages.length >= view.sent.length) {
      const firstOpen = messages.findIndex((m) => (m.kind === "assistant" && !m.done) || (m.kind === "shell" && m.status === "running"));
      from = Math.max(0, Math.min(view.sent.length - 1, firstOpen === -1 ? messages.length : firstOpen));
    }
    view.sent = { length: messages.length, key };
    view.post({ type: "session", session: meta, from, tail: messages.slice(from) });
  }

  private async resyncAll() {
    const ids = new Set<string>();
    for (const v of this.views) if (v.sessionID) ids.add(v.sessionID);
    for (const id of ids) await this.loadSession(id).catch((e) => this.log.warn(`resync ${id}: ${e.message}`));
    await this.loadPending().catch(() => {});
    for (const v of this.views) if (v.sessionID) this.sendSession(v, true);
  }

  /**
   * The whole session as a diff range: the server's default is only the
   * newest turn, which would drop files edited earlier from the list.
   */
  private sessionRange(id: string): { from?: string; to?: string } {
    const users = this.store.get(id).messages.filter((m) => m.kind === "user");
    return { from: users[0]?.id, to: users[users.length - 1]?.id };
  }

  /** Changed files of a session and its workers, from the server's diffs. */
  private async refreshChanges(id: string) {
    const api = this.api;
    if (!api) return;
    const s = this.store.get(id);
    const stats: Record<string, { additions: number; deletions: number }> = {};
    for (const sid of [s.id, ...s.children.map((c) => c.id)]) {
      for (const d of await api.diff(sid, this.sessionRange(sid)).catch(() => [])) {
        if (d.patch) stats[this.resolvePath(d.file).fsPath] = { additions: d.additions, deletions: d.deletions };
      }
    }
    const next = Object.keys(stats).sort();
    if (JSON.stringify([next, stats]) === JSON.stringify([s.changedFiles, s.fileStats ?? {}])) return;
    s.changedFiles = next;
    s.fileStats = stats;
    this.markDirty(id);
  }

  private async loadSession(id: string): Promise<SessionView> {
    const api = this.api!;
    const [info, items, inbox, active] = await Promise.all([api.sessionRaw(id), api.messages(id), api.inbox(id).catch(() => []), api.active().catch(() => undefined)]);
    const s = this.store.loadHistory(info, items);
    this.store.loadInbox(id, inbox);
    // History says nothing about whether a turn runs now; a turn may have
    // started or ended while the event stream was down.
    if (active) s.status = active.includes(id) ? "busy" : s.status === "busy" ? "idle" : s.status;
    // Child sessions are listed by parent; refresh their titles/status.
    const children = await api.children(id).catch(() => []);
    for (const c of children) {
      const existing = s.children.find((x) => x.id === c.id);
      if (existing) existing.title = c.title;
      else s.children.push({ id: c.id, title: c.title, agent: c.agent, status: "idle" });
    }
    await this.refreshChanges(id);
    if (info?.time?.idle && !(info.time.viewed >= info.time.idle)) void api.view(id, info.time.idle).catch(() => {});
    return s;
  }

  /** The user saw this session finish, if it is on screen in a focused window. */
  private markViewed(id: string) {
    if (!vscode.window.state.focused || ![...this.views].some((v) => v.sessionID === id)) return;
    const api = this.api;
    void api
      ?.sessionRaw(id)
      .then((info) => info?.time?.idle && api.view(id, info.time.idle))
      .catch(() => {});
  }

  private async loadPending() {
    const api = this.api!;
    const perms = await api.pendingPermissions().catch(() => []);
    for (const p of perms ?? []) for (const id of this.store.apply({ type: "permission.asked", data: p })) this.markDirty(id);
  }

  // ---------- webview intents ----------

  async handle(view: ChatView, msg: WebviewToHost) {
    try {
      await this.dispatch(view, msg);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      this.log.error(message);
      view.post({ type: "error", message });
    }
  }

  private async dispatch(view: ChatView, msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.initView(view);
        await this.ensureServer();
        // A restored view reopens its session, which also syncs the agent,
        // node and thinking pickers to it.
        if (view.sessionID && this.api) {
          await this.openSession(view, view.sessionID).catch(() => {
            view.sessionID = undefined;
            this.remember(view);
            view.post({ type: "noSession" });
          });
        }
        return;
      case "send":
        return this.send(view, msg.text, msg.attachContext, msg.delivery, msg.attachments);
      case "command": {
        const id = await this.ensureSession(view);
        await this.api!.command(id, msg.name, msg.text);
        return;
      }
      case "interrupt":
        if (view.sessionID && this.api) await this.api.interrupt(view.sessionID);
        return;
      case "newSession":
        view.sessionID = undefined;
        view.sent = { length: 0 };
        this.remember(view);
        view.post({ type: "noSession" });
        return;
      case "listSessions":
        return this.sendSessions(view);
      case "deleteSession":
        return this.deleteSession(msg.id);
      case "openSession":
        if (msg.inNewTab) {
          await vscode.commands.executeCommand("tellico.openInTab", msg.id);
          return;
        }
        return this.openSession(view, msg.id);
      case "setPrefs":
        return this.setPrefs(view, msg.prefs);
      case "permission": {
        await this.api!.replyPermission(msg.sessionID, msg.requestID, msg.decision);
        for (const id of this.store.apply({ type: "permission.replied", data: { sessionID: msg.sessionID, requestID: msg.requestID } })) this.markDirty(id);
        return;
      }
      case "formReply":
        await this.api!.replyForm(msg.sessionID, msg.formID, msg.answer);
        for (const id of this.store.apply({ type: "form.replied", data: { formID: msg.formID } })) this.markDirty(id);
        return;
      case "formCancel":
        await this.api!.cancelForm(msg.sessionID, msg.formID);
        for (const id of this.store.apply({ type: "form.cancelled", data: { formID: msg.formID } })) this.markDirty(id);
        return;
      case "openFile":
        return this.openFile(msg.path, msg.line);
      case "openDiff":
        return this.openDiff(view, msg.path);
      case "revertFile":
        return this.revertFile(view, msg.path);
      case "copy":
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage("$(check) Copied", 1500);
        return;
      case "setGatewayKey":
        if (await this.promptGatewayKey()) await this.restart();
        return;
      case "restartServer":
        return this.restart();
      case "showLogs":
        this.log.show();
        return;
      case "rewind":
        return this.rewind(view, msg.messageID, msg.files);
      case "editMessage":
        return this.editMessage(view, msg.messageID);
      case "fork":
        return this.fork(view, msg.messageID);
      case "revertUndo":
        if (view.sessionID) await this.api?.revertClear(view.sessionID);
        return;
      case "revertCommit":
        if (view.sessionID) await this.api?.revertCommit(view.sessionID);
        return;
      case "pending":
        if (!view.sessionID || !this.api) return;
        if (msg.action === "cancel") await this.api.cancelInbox(view.sessionID, msg.id);
        else await this.api.steerInbox(view.sessionID, msg.id);
        return;
      case "compact": {
        const id = await this.ensureSession(view);
        await this.api!.compact(id);
        return;
      }
      case "shell": {
        const id = await this.ensureSession(view);
        await this.api!.shell(id, msg.command);
        return;
      }
      case "renameSession":
        return this.renameSession(msg.id, msg.title);
      case "pinSession":
        await this.api?.setMetadata(msg.id, { pinned: msg.pinned });
        return this.sendSessions(...this.views);
      case "findFiles":
        return this.findFiles(view, msg.query);
      case "pickFiles":
        return this.pickFiles(view);
      case "stopWorker":
        await this.api?.interrupt(msg.id);
        return;
      case "mcpList":
        return this.refreshMcp();
      case "mcpToggle":
        if (!this.api) return;
        if (msg.name === IDE_SERVER) {
          await vscode.workspace.getConfiguration("tellico").update("ideTools", msg.enable, vscode.ConfigurationTarget.Global);
          return;
        }
        await (msg.enable ? this.api.connectMcp(msg.name) : this.api.disconnectMcp(msg.name));
        return this.refreshMcp();
      case "mcpAuth":
        return this.mcpAuth(msg.name);
      case "mcpAdd":
        await this.mcp.add(
          this.mcpServers.map((m) => m.name),
          vscode.workspace.getConfiguration("tellico").get<string[]>("mcpSearchPaths", []),
        );
        return;
      case "mcpFixConfig":
        this.mcp.fix(msg.file);
        void vscode.window.setStatusBarMessage("$(check) MCP config fixed; OpenCode applies it in a few seconds", 4000);
        return this.refreshMcp();
      case "mcpImport":
        await this.mcp.importFromVsCode();
        return;
      case "mcpOpenConfig":
        await this.mcp.openConfig();
        return;
      case "savedPermissions":
        return this.sendSavedPermissions(view);
      case "removeSavedPermission":
        await this.api?.removeSavedPermission(msg.id);
        return this.sendSavedPermissions(view);
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:yejashi.tellico-vscode");
        return;
    }
  }

  private async ensureSession(view: ChatView): Promise<string> {
    await this.ensureServer();
    if (!this.api) throw new Error("The Tellico server is not running.");
    if (view.sessionID) return view.sessionID;
    const agent = tellicoAgent(this.prefs.mode, this.prefs.node);
    const info = await this.api.createSession(agent, this.modelFor(this.prefs.node, this.prefs.think));
    view.sessionID = info.id;
    view.sent = { length: 0 };
    const s = this.store.get(info.id);
    s.agent = info.agent;
    s.model = info.model;
    this.sendSession(view, true);
    return info.id;
  }

  private modelFor(node: 0 | 1, think: ThinkLevel): ModelRef {
    const agent = this.agents.find((a) => a.id === tellicoAgent("build", node));
    return { id: agent?.modelID ?? "", providerID: agent?.providerID ?? `tellico-${node}`, variant: think };
  }

  private async send(view: ChatView, text: string, attachContext: boolean, delivery?: Delivery, attachments?: Attachment[]) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // `!cmd` runs in the session's shell, outside any model turn; its output
    // reaches the model with the next prompt.
    const bang = /^!\s*([\s\S]+)$/.exec(trimmed);
    if (bang) {
      const id = await this.ensureSession(view);
      await this.api!.shell(id, bang[1]);
      return;
    }
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
    if (slash && this.commands.some((c) => c.name === slash[1])) {
      const id = await this.ensureSession(view);
      await this.api!.command(id, slash[1], slash[2], delivery);
      return;
    }
    if (slash && /^think-(off|low|medium|xhigh)$/.test(slash[1])) {
      // OpenCode 2 has no per-request variant; set the session's level instead.
      await this.setPrefs(view, { think: slash[1].slice(6) as ThinkLevel });
      if (!slash[2].trim()) return;
      text = slash[2];
    }
    if (attachments?.some((a) => a.kind === "image") && !this.prefs.images) {
      throw new Error("The Tellico model does not accept images; describe it in words or attach a text file instead.");
    }
    const id = await this.ensureSession(view);
    let active: { path: string; range?: { start: number; end: number } } | undefined;
    if (attachContext && this.prefs.attachActiveEditor) {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === "file") active = { path: ed.document.uri.fsPath, range: this.context.selection };
    }
    const files = buildPromptFiles({ text, root: this.directory ?? "/", attachments, active, exists: attachable });
    await this.api!.prompt(id, text, files, delivery);
  }

  private async setPrefs(view: ChatView, p: Partial<Prefs>) {
    if (p.connectionSetting !== undefined) {
      await this.setConnection(p.connectionSetting);
      return;
    }
    const prev = { ...this.prefs };
    Object.assign(this.prefs, p);
    if (p.attachActiveEditor !== undefined) {
      await vscode.workspace.getConfiguration("tellico").update("attachActiveEditor", p.attachActiveEditor, vscode.ConfigurationTarget.Global);
    }
    this.broadcast({ type: "prefs", prefs: this.prefs });
    this.renderStatus();
    // Apply to the session in this view, if it exists and is a Tellico lead.
    const sid = view.sessionID;
    if (!sid || !this.api) return;
    const s = this.store.get(sid);
    if (s.parentID) return;
    if (p.mode !== undefined || p.node !== undefined) {
      const agent = tellicoAgent(this.prefs.mode, this.prefs.node);
      if (agent !== s.agent) {
        await this.api.switchAgent(sid, agent);
        s.agent = agent;
      }
    }
    if (p.node !== undefined || p.think !== undefined) {
      if (prev.node !== this.prefs.node || prev.think !== this.prefs.think) {
        const model = this.modelFor(this.prefs.node, this.prefs.think);
        await this.api.switchModel(sid, model);
        s.model = model;
      }
    }
    this.markDirty(sid);
  }

  // ---------- checkpoints ----------

  private busyGuard(id: string) {
    if (this.store.get(id).status === "busy") throw new Error("Stop the running turn first (Esc), then rewind.");
  }

  /** Rewinds to before a user message: its turn and everything after set aside. */
  private async rewind(view: ChatView, messageID: string, files: boolean) {
    const id = view.sessionID;
    if (!id || !this.api) return;
    this.busyGuard(id);
    const r = await this.api.revertStage(id, messageID, files);
    if (files && r.files.length) void vscode.window.setStatusBarMessage(`$(history) Restored ${r.files.length} file${r.files.length > 1 ? "s" : ""}`, 3000);
  }

  /** Rewinds and puts the message back in the composer; sending commits the rewind. */
  private async editMessage(view: ChatView, messageID: string) {
    const id = view.sessionID;
    if (!id) return;
    const m = this.store.get(id).messages.find((x) => x.id === messageID);
    await this.rewind(view, messageID, true);
    if (m?.kind === "user") view.post({ type: "setComposer", text: m.text });
  }

  /** A new session with the conversation up to (not including) this message. */
  private async fork(view: ChatView, messageID: string) {
    const id = view.sessionID;
    if (!id || !this.api) return;
    const m = this.store.get(id).messages.find((x) => x.id === messageID);
    const info = await this.api.fork(id, messageID);
    await this.openSession(view, info.id);
    if (m?.kind === "user") view.post({ type: "setComposer", text: m.text });
  }

  async openSession(view: ChatView, id: string) {
    await this.ensureServer();
    if (!this.api) return;
    view.sessionID = id;
    view.sent = { length: 0 };
    const s = await this.loadSession(id);
    // Another session was picked while this one loaded.
    if (view.sessionID !== id) return;
    const parsed = parseTellicoAgent(s.agent);
    if (parsed && !s.parentID) {
      this.prefs.mode = parsed.mode;
      this.prefs.node = parsed.node;
      const variant = s.model?.variant;
      if (variant === "off" || variant === "low" || variant === "medium" || variant === "xhigh") this.prefs.think = variant;
      this.broadcast({ type: "prefs", prefs: this.prefs });
    }
    this.sendSession(view, true);
    view.reveal();
  }

  /** Opens a session in the sidebar, or the first view if there is none. */
  private async openInPrimary(id: string) {
    await vscode.commands.executeCommand("tellico.chat.focus");
    const view = [...this.views].find((v) => v.id.startsWith("sidebar")) ?? [...this.views][0];
    if (view) await this.openSession(view, id);
  }

  /** Opens a panel in a view (view title buttons, commands). */
  async showPanel(view: ChatView, panel: "history" | "stats" | "mcp") {
    view.reveal();
    view.post({ type: "showPanel", panel });
    if (panel === "history") await this.sendSessions(view);
    if (panel === "mcp") await this.refreshMcp();
  }

  private async sendSessions(...views: ChatView[]) {
    await this.ensureServer();
    if (!this.api) return;
    const [list, active] = await Promise.all([this.api.sessions(200), this.api.active().catch(() => [])]);
    const busy = new Set(active);
    const sessions: SessionSummary[] = list.map((s) => ({
      id: s.id,
      title: s.title,
      created: s.created,
      updated: s.updated,
      agent: s.agent,
      busy: busy.has(s.id) || undefined,
      unread: Boolean(s.idle && !(s.viewed && s.viewed >= s.idle) && !busy.has(s.id)) || undefined,
      pinned: s.pinned || undefined,
    }));
    for (const v of views) v.post({ type: "sessions", sessions });
  }

  private async renameSession(id: string, title?: string) {
    if (!this.api) return;
    const current = this.store.sessions.get(id)?.title ?? (await this.api.session(id).catch(() => undefined))?.title;
    const next = title ?? (await vscode.window.showInputBox({ title: "Rename session", value: current, validateInput: (v) => (v.trim() ? undefined : "Enter a title") }));
    if (!next?.trim()) return;
    await this.api.rename(id, next.trim());
    await this.sendSessions(...this.views);
  }

  private async deleteSession(id: string) {
    if (!this.api) return;
    const title = (await this.api.session(id).catch(() => undefined))?.title ?? "this session";
    const ok = await vscode.window.showWarningMessage(`Delete "${title}"? Its transcript cannot be recovered.`, { modal: true }, "Delete");
    if (ok !== "Delete") return;
    await this.api.remove(id);
    this.store.sessions.delete(id);
    for (const v of this.views) {
      if (v.sessionID === id) {
        v.sessionID = undefined;
        v.sent = { length: 0 };
        this.remember(v);
        v.post({ type: "noSession" });
      }
    }
    await this.sendSessions(...this.views);
  }

  // ---------- MCP ----------

  private async refreshMcp() {
    const api = this.api;
    if (!api) return;
    const list = await api.mcp().catch(() => []);
    this.mcpServers = list.map((m) => ({
      name: m.name,
      status: m.status,
      error: m.error,
      canAuth: Boolean(m.integrationID) && m.status === "needs_auth",
      builtin: m.name === IDE_SERVER && this.ide.running,
    }));
    if (!this.ideToolsEnabled && !this.mcpServers.some((m) => m.name === IDE_SERVER))
      this.mcpServers.push({ name: IDE_SERVER, status: "disabled", canAuth: false, builtin: true });
    this.mcpIssues = this.mcp.lint();
    this.broadcast({ type: "mcp", servers: this.mcpServers, issues: this.mcpIssues });
  }

  /** OAuth sign-in for a remote MCP server, in the browser. */
  private async mcpAuth(name: string) {
    const api = this.api;
    if (!api) return;
    const server = (await api.mcp()).find((m) => m.name === name);
    if (!server?.integrationID) throw new Error(`${name} has no sign-in to start.`);
    const integrationID = server.integrationID;
    const attempt = await api.startOAuth(integrationID);
    if (!attempt) throw new Error(`${name} does not offer OAuth sign-in.`);
    await vscode.env.openExternal(vscode.Uri.parse(attempt.url));
    if (attempt.mode === "code") {
      const code = await vscode.window.showInputBox({ title: `Sign in to ${name}`, prompt: attempt.instructions ?? "Paste the code the browser shows", ignoreFocusOut: true });
      if (!code) return;
      await api.completeOAuth(integrationID, attempt.attemptID, code.trim());
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Waiting for ${name} sign-in…`, cancellable: true }, async (_p, token) => {
      for (let i = 0; i < 150 && !token.isCancellationRequested; i++) {
        const st = await api.oauthStatus(integrationID, attempt.attemptID).catch(() => "pending");
        if (st === "complete") return;
        if (st === "failed" || st === "expired") throw new Error(`${name} sign-in ${st}.`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    });
    await api.connectMcp(name).catch(() => {});
    await this.refreshMcp();
  }

  private async sendSavedPermissions(view: ChatView) {
    if (!this.api) return;
    const items = await this.api.savedPermissions(await this.api.projectID().catch(() => undefined)).catch(() => []);
    view.post({ type: "savedPermissions", items: items.map((p) => ({ id: p.id, action: p.action, resource: p.resource })) });
  }

  // ---------- editor integration ----------

  private updateContext() {
    const ed = vscode.window.activeTextEditor;
    const ctx: EditorContext = {};
    if (ed && ed.document.uri.scheme === "file") {
      ctx.file = vscode.workspace.asRelativePath(ed.document.uri);
      if (!ed.selection.isEmpty) {
        const end = ed.selection.end.character === 0 && ed.selection.end.line > ed.selection.start.line ? ed.selection.end.line : ed.selection.end.line + 1;
        ctx.selection = { start: ed.selection.start.line + 1, end };
      }
    }
    if (JSON.stringify(ctx) === JSON.stringify(this.context)) return;
    this.context = ctx;
    this.broadcast({ type: "context", context: ctx });
  }

  /** Alt+K: put an @-reference to the selection into the composer. */
  insertSelectionReference(view: ChatView) {
    this.updateContext();
    const { file, selection } = this.context;
    if (!file) return;
    view.post({ type: "insertText", text: selection ? `@${file}#L${selection.start}-${selection.end} ` : `@${file} ` });
  }

  insertText(view: ChatView, text: string) {
    view.reveal();
    view.post({ type: "insertText", text });
  }

  /** Sends a prompt from outside the chat (code actions, editor commands). */
  async sendFrom(view: ChatView, text: string, attachments: Attachment[] = []) {
    view.reveal();
    await this.handle(view, { type: "send", text, attachContext: false, attachments });
  }

  /** @-mention completions: open editors first when the query is empty. */
  private async findFiles(view: ChatView, query: string) {
    let items: { path: string; type: "file" | "directory" }[] = [];
    if (!query) {
      const seen = new Set<string>();
      for (const g of vscode.window.tabGroups.all)
        for (const t of g.tabs)
          if (t.input instanceof vscode.TabInputText && t.input.uri.scheme === "file") {
            const p = vscode.workspace.asRelativePath(t.input.uri, false);
            if (!seen.has(p)) {
              seen.add(p);
              items.push({ path: p, type: "file" });
            }
          }
      items = items.slice(0, 12);
    } else if (this.api) {
      items = await this.api.findFiles(query).catch(() => []);
    }
    view.post({ type: "fileMatches", query, items });
  }

  private async pickFiles(view: ChatView) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: true, defaultUri: this.directory ? vscode.Uri.file(this.directory) : undefined, openLabel: "Attach" });
    if (!picked?.length) return;
    const refs = picked.map((u) => `@${vscode.workspace.asRelativePath(u, false).replace(/ /g, "\\ ")}`).join(" ");
    view.post({ type: "insertText", text: refs + " " });
  }

  private resolvePath(p: string): vscode.Uri {
    if (p.startsWith("/")) return vscode.Uri.file(p);
    return vscode.Uri.joinPath(vscode.Uri.file(this.directory ?? "/"), p);
  }

  async openFile(p: string, line?: number) {
    const doc = await vscode.workspace.openTextDocument(this.resolvePath(p));
    const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Original text of a file the session changed, rebuilt from its patch. */
  private async originalOf(view: ChatView, p: string): Promise<{ uri: vscode.Uri; original: string; rel: string } | undefined> {
    if (!view.sessionID || !this.api) return undefined;
    const uri = this.resolvePath(p);
    const rel = vscode.workspace.asRelativePath(uri, false);
    // A worker's edits may only be recorded in its own session's diff.
    const session = this.store.get(view.sessionID);
    let d;
    for (const id of [session.id, ...session.children.map((c) => c.id)]) {
      const diffs = await this.api.diff(id, this.sessionRange(id)).catch(() => []);
      d = diffs.find((x) => x.file === rel || this.resolvePath(x.file).fsPath === uri.fsPath);
      if (d) break;
    }
    if (!d) {
      void vscode.window.showInformationMessage(`${rel} has no changes in this session.`);
      return undefined;
    }
    let current = "";
    try {
      current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      current = "";
    }
    if (d.status === "deleted") return { uri, original: reverseDeleted(d.patch), rel };
    const original = reversePatch(current, d.patch);
    if (original === undefined) {
      void vscode.window.showWarningMessage(`${rel} has changed since the session edited it; cannot rebuild the original.`);
      return undefined;
    }
    return { uri, original, rel };
  }

  async openDiff(view: ChatView, p: string) {
    const r = await this.originalOf(view, p);
    if (!r) return;
    const beforeUri = this.before.set(r.rel, r.original);
    await vscode.commands.executeCommand("vscode.diff", beforeUri, r.uri, `${r.rel} (Tellico changes)`, { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  async revertFile(view: ChatView, p: string) {
    const r = await this.originalOf(view, p);
    if (!r) return;
    const ok = await vscode.window.showWarningMessage(`Revert ${r.rel} to its state before this session?`, { modal: true }, "Revert");
    if (ok !== "Revert") return;
    await vscode.workspace.fs.writeFile(r.uri, new TextEncoder().encode(r.original));
  }

  showLogs() {
    this.log.show();
  }

  dispose() {
    this.stream?.stop();
    void this.ide.unregister(this.api);
    this.manager?.stop();
    for (const d of this.disposables) d.dispose();
  }
}

function reverseDeleted(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1))
    .join("\n");
}

export { BEFORE_SCHEME };
