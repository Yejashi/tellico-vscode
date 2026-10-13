import * as vscode from "vscode";
import { Controller } from "./controller";
import { BEFORE_SCHEME, BeforeContentProvider } from "./diff/beforeProvider";
import { openChatTab, SidebarProvider } from "./views/chatViews";

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext) {
  const before = new BeforeContentProvider();
  controller = new Controller(context, before);
  const sidebar = new SidebarProvider(context.extensionUri, controller);
  let lastTab: ReturnType<typeof openChatTab> | undefined;

  const activeView = () => sidebar.view ?? lastTab;

  context.subscriptions.push(
    controller,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, before),
    vscode.window.registerWebviewViewProvider("tellico.chat", sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("tellico.focus", () => vscode.commands.executeCommand("tellico.chat.focus")),
    vscode.commands.registerCommand("tellico.newSession", async () => {
      await vscode.commands.executeCommand("tellico.chat.focus");
      const v = sidebar.view;
      if (v) await controller!.handle(v, { type: "newSession" });
    }),
    vscode.commands.registerCommand("tellico.openInTab", (sessionID?: string) => {
      lastTab = openChatTab(context.extensionUri, controller!, typeof sessionID === "string" ? sessionID : undefined);
    }),
    vscode.commands.registerCommand("tellico.history", async () => {
      await vscode.commands.executeCommand("tellico.chat.focus");
      const v = activeView();
      if (v) await controller!.showHistory(v);
    }),
    vscode.commands.registerCommand("tellico.addSelection", async () => {
      await vscode.commands.executeCommand("tellico.chat.focus");
      const v = activeView();
      if (v) controller!.insertSelectionReference(v);
    }),
    vscode.commands.registerCommand("tellico.restartServer", () => controller!.restart()),
    vscode.commands.registerCommand("tellico.switchConnection", () => controller!.pickConnection()),
    vscode.commands.registerCommand("tellico.setGatewayKey", async () => {
      if (await controller!.promptGatewayKey()) await controller!.restart();
    }),
    vscode.commands.registerCommand("tellico.showLogs", () => controller!.showLogs()),
    vscode.commands.registerCommand("tellico.openChanges", (path: string) => {
      const v = activeView();
      if (v && typeof path === "string") return controller!.openDiff(v, path);
    }),
  );
}

export function deactivate() {
  controller?.dispose();
  controller = undefined;
}
