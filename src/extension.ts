import * as vscode from "vscode";
import { ChatView, Controller } from "./controller";
import { BEFORE_SCHEME, BeforeContentProvider } from "./diff/beforeProvider";
import { openChatTab, SidebarProvider, TAB_VIEW_TYPE, TabSerializer } from "./views/chatViews";
import { explainPrompt, fixPrompt, TellicoCodeActions, terminalBlock, TerminalWatcher, terminalSelection } from "./integrations";

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext) {
  const before = new BeforeContentProvider();
  const c = (controller = new Controller(context, before));
  const sidebar = new SidebarProvider(context.extensionUri, c);
  const terminals = new TerminalWatcher();
  let lastTab: ChatView | undefined;

  const activeView = () => sidebar.view ?? lastTab;
  /** The sidebar, focused and ready to take input. */
  const chat = async (): Promise<ChatView | undefined> => {
    await vscode.commands.executeCommand("tellico.chat.focus");
    return activeView();
  };
  const withChat = (fn: (v: ChatView) => unknown) => async () => {
    const v = await chat();
    if (v) await fn(v);
  };

  context.subscriptions.push(
    c,
    terminals,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, before),
    vscode.window.registerWebviewViewProvider("tellico.chat", sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(TAB_VIEW_TYPE, new TabSerializer(context.extensionUri, c, (v) => (lastTab = v))),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new TellicoCodeActions(), { providedCodeActionKinds: TellicoCodeActions.kinds }),
    vscode.commands.registerCommand("tellico.focus", () => vscode.commands.executeCommand("tellico.chat.focus")),
    vscode.commands.registerCommand("tellico.newSession", withChat((v) => c.handle(v, { type: "newSession" }))),
    vscode.commands.registerCommand("tellico.openInTab", (sessionID?: string) => {
      lastTab = openChatTab(context.extensionUri, c, typeof sessionID === "string" ? sessionID : undefined);
    }),
    vscode.commands.registerCommand("tellico.history", withChat((v) => c.showPanel(v, "history"))),
    vscode.commands.registerCommand("tellico.stats", withChat((v) => c.showPanel(v, "stats"))),
    vscode.commands.registerCommand("tellico.mcp", withChat((v) => c.showPanel(v, "mcp"))),
    vscode.commands.registerCommand("tellico.mcpAdd", withChat((v) => c.handle(v, { type: "mcpAdd" }))),
    vscode.commands.registerCommand("tellico.mcpImport", withChat((v) => c.handle(v, { type: "mcpImport" }))),
    vscode.commands.registerCommand("tellico.compact", withChat((v) => c.handle(v, { type: "compact" }))),
    vscode.commands.registerCommand("tellico.stop", () => {
      const v = activeView();
      if (v) return c.handle(v, { type: "interrupt" });
    }),
    vscode.commands.registerCommand("tellico.addSelection", withChat((v) => c.insertSelectionReference(v))),
    vscode.commands.registerCommand("tellico.explainSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      const prompt = ed && explainPrompt(ed);
      if (!prompt) return;
      const v = await chat();
      if (v) await c.sendFrom(v, prompt);
    }),
    vscode.commands.registerCommand("tellico.fixProblems", async (uri?: vscode.Uri, problems?: vscode.Diagnostic[]) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const all = problems ?? vscode.languages.getDiagnostics(target).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      if (!all.length) {
        void vscode.window.showInformationMessage("No errors in this file.");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(target);
      const v = await chat();
      if (v) await c.sendFrom(v, fixPrompt(target, all, doc.lineCount));
    }),
    vscode.commands.registerCommand("tellico.sendTerminalSelection", async () => {
      const text = await terminalSelection();
      if (!text.trim()) {
        void vscode.window.showInformationMessage("Select some terminal output first.");
        return;
      }
      const v = await chat();
      if (v) c.insertText(v, terminalBlock(undefined, text));
    }),
    vscode.commands.registerCommand("tellico.sendLastTerminalCommand", async () => {
      const last = terminals.lastCommand(vscode.window.activeTerminal);
      if (!last) {
        void vscode.window.showInformationMessage("No command recorded in the active terminal yet (needs shell integration).");
        return;
      }
      const v = await chat();
      if (v) c.insertText(v, terminalBlock(last.command, last.output, last.exit));
    }),
    vscode.commands.registerCommand("tellico.restartServer", () => c.restart()),
    vscode.commands.registerCommand("tellico.switchConnection", () => c.pickConnection()),
    vscode.commands.registerCommand("tellico.setGatewayKey", async () => {
      if (await c.promptGatewayKey()) await c.restart();
    }),
    vscode.commands.registerCommand("tellico.showLogs", () => c.showLogs()),
    vscode.commands.registerCommand("tellico.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:yejashi.tellico-vscode")),
    vscode.commands.registerCommand("tellico.openChanges", (path: string) => {
      const v = activeView();
      if (v && typeof path === "string") return c.openDiff(v, path);
    }),
  );
}

export function deactivate() {
  controller?.dispose();
  controller = undefined;
}
