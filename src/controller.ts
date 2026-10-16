// One controller per window: owns the server process, the API client, the
// event stream and the store, and fans session updates out to every open chat
// view (the sidebar and any editor tabs). Each view shows one session.

import * as vscode from "vscode";
import { AgentInfo, Api, Connection } from "./server/api";
import { EventStream } from "./server/events";
import { LaunchSettings, ServerManager, ServerState } from "./server/manager";
import { Store } from "./state/reducer";
import { Mode, ModelRef, parseTellicoAgent, SessionView, tellicoAgent, ThinkLevel } from "../shared/model";
import { EditorContext, HostToWebview, Prefs, ServerStatus, WebviewToHost } from "../shared/protocol";
import { reversePatch } from "./diff/patch";
import { ConnectionSetting, effectiveConnection, hasKey, installedMode, writeGatewayKey } from "./server/connection";
import { BEFORE_SCHEME, BeforeContentProvider } from "./diff/beforeProvider";

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
  private prefs: Prefs;
  private context: EditorContext = {};
  private dirty = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private starting?: Promise<Connection | undefined>;
  private readonly disposables: vscode.Disposable[] = [];
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
    this.renderStatus();

    this.disposables.push(
      this.log,
      this.statusItem,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateContext()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          ["showReasoning", "attachActiveEditor", "smoothStreaming"].some((k) => e.affectsConfiguration(`tellico.${k}`))
        ) {
          const c = vscode.workspace.getConfiguration("tellico");
          this.prefs.showReasoning = c.get("showReasoning", false);
          this.prefs.smoothStreaming = c.get("smoothStreaming", true);
          this.prefs.attachActiveEditor = c.get("attachActiveEditor", true);
          this.broadcast({ type: "prefs", prefs: this.prefs });
        }
        if (
          ["launcherPath", "leadNode", "magicContext", "backgroundSubagents", "connection", "gatewayUrl"].some((k) =>
            e.affectsConfiguration(`tellico.${k}`),
          )
        ) {
          this.prefs.magicContext = vscode.workspace.getConfiguration("tellico").get("magicContext", true);
          // A connection change made from the chat restarts by itself.
          if (this.restartingForConnection) return;
          void vscode.window
            .showInformationMessage("Tellico server settings changed.", "Restart Server")
            .then((pick) => pick && this.restart());
        }
      }),
    );
    this.updateContext();
  }

  get directory(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    this.starting = this.manager
      .start()
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
    };
  }

  private onManagerState(s: ServerState) {
    if (s.kind === "ready") return; // reported after connect() has loaded agents
    if (s.kind === "starting" && this.serverStatus.kind === "ready") {
      this.stream?.stop();
      this.api = undefined;
    }
    this.setServer(s.kind === "failed" ? { kind: "failed", message: s.message } : { kind: s.kind });
    if (s.kind === "starting" && !this.starting && this.manager) {
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
    this.commands = (await api.commands().catch(() => [])).filter((c) => !c.name.startsWith("think-"));
    const node = this.configuredNode() ?? (await api.defaultNode().catch(() => undefined)) ?? 0;
    this.prefs.node = node;
    this.stream?.stop();
    this.stream = new EventStream(api, {
      onEvent: (ev) => {
        for (const id of this.store.apply(ev)) this.markDirty(id);
        // When a turn ends, take the authoritative changed-file list from the
        // server: it includes workers' edits and files changed by shell commands.
        if (/^session\.execution\.(succeeded|interrupted|failed)$/.test(ev.type) || ev.type === "session.revert.staged" || ev.type === "session.revert.cleared") {
          const sid = ev.data?.sessionID as string | undefined;
          const root = sid ? this.store.sessions.get(sid) : undefined;
          const lead = root?.parentID ?? root?.id;
          if (lead && [...this.views].some((v) => v.sessionID === lead)) void this.refreshChanges(lead);
        }
      },
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
    await this.resyncAll();
  }

  private configuredNode(): 0 | 1 | undefined {
    const v = vscode.workspace.getConfiguration("tellico").get<string>("leadNode", "auto");
    return v === "0" ? 0 : v === "1" ? 1 : undefined;
  }

  private restartingForConnection = false;

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
    const busy = [...this.store.sessions.values()].some((x) => x.status === "busy" && !x.parentID);
    const icon = s.kind === "ready" ? (busy ? "$(sync~spin)" : "$(hubot)") : s.kind === "starting" ? "$(loading~spin)" : s.kind === "failed" ? "$(error)" : "$(circle-slash)";
    const via = this.prefs.connection === "gateway" ? "gateway" : "SSH";
    this.statusItem.text = `${icon} Tellico${s.kind === "ready" ? ` · ${this.prefs.mode} · node ${this.prefs.node} · ${via}` : ""}`;
    this.statusItem.tooltip = s.kind === "failed" ? s.message : `Tellico server: ${s.kind}`;
  }

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
    this.renderStatus();
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
    const { messages, ...meta } = s;
    // Everything but the transcript is small; send it every time. The
    // transcript is re-sent from the first message that can still change.
    const key = JSON.stringify([meta.status, meta.permissions.length, meta.forms.length, meta.children.length]);
    let from = 0;
    if (!full && view.sent.key === key && messages.length >= view.sent.length) {
      const firstOpen = messages.findIndex((m) => m.kind === "assistant" && !m.done);
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

  /**
   * The whole session as a diff range: the server's default is only the
   * newest turn, which would drop files edited earlier from the list.
   */
  private sessionRange(id: string): { from?: string; to?: string } {
    const users = this.store.get(id).messages.filter((m) => m.kind === "user");
    return { from: users[0]?.id, to: users[users.length - 1]?.id };
  }

  private async loadSession(id: string): Promise<SessionView> {
    const api = this.api!;
    const [info, items, inbox] = await Promise.all([api.sessionRaw(id), api.messages(id), api.inbox(id).catch(() => [])]);
    const s = this.store.loadHistory(info, items);
    this.store.loadInbox(id, inbox);
    // Child sessions are listed by parent; refresh their titles/status.
    const children = await api.children(id).catch(() => []);
    for (const c of children) {
      const existing = s.children.find((x) => x.id === c.id);
      if (existing) existing.title = c.title;
      else s.children.push({ id: c.id, title: c.title, agent: c.agent, status: "idle" });
    }
    await this.refreshChanges(id);
    return s;
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
        return this.send(view, msg.text, msg.attachContext);
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
        for (const id of this.store.apply({ type: "permission.replied", data: { sessionID: msg.sessionID, requestID: msg.requestID } }))
          this.markDirty(id);
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

  private async send(view: ChatView, text: string, attachContext: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
    if (slash && this.commands.some((c) => c.name === slash[1])) {
      const id = await this.ensureSession(view);
      await this.api!.command(id, slash[1], slash[2]);
      return;
    }
    if (slash && /^think-(off|low|medium|xhigh)$/.test(slash[1])) {
      // OpenCode 2 has no per-request variant; set the session's level instead.
      await this.setPrefs(view, { think: slash[1].slice(6) as ThinkLevel });
      if (!slash[2].trim()) return;
      text = slash[2];
    }
    const id = await this.ensureSession(view);
    const files: { uri: string; name?: string }[] = [];
    let body = text;
    if (attachContext && this.prefs.attachActiveEditor) {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === "file") {
        files.push({ uri: ed.document.uri.toString(), name: vscode.workspace.asRelativePath(ed.document.uri) });
        const sel = this.context.selection;
        if (sel) body += `\n\n(Selected: ${this.context.file}#L${sel.start}-${sel.end})`;
      }
    }
    await this.api!.prompt(id, body, files);
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

  async openSession(view: ChatView, id: string) {
    await this.ensureServer();
    if (!this.api) return;
    view.sessionID = id;
    view.sent = { length: 0 };
    const s = await this.loadSession(id);
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

  /** The view title's history button: the webview shows its own browser. */
  async showHistory(view: ChatView) {
    view.reveal();
    view.post({ type: "showHistory" });
    await this.sendSessions(view);
  }

  private async sendSessions(...views: ChatView[]) {
    await this.ensureServer();
    if (!this.api) return;
    const sessions = (await this.api.sessions(200)).map((s) => ({ id: s.id, title: s.title, created: s.created, updated: s.updated, agent: s.agent }));
    for (const v of views) v.post({ type: "sessions", sessions });
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
