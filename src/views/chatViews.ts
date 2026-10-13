// The two hosts for the same React app: the sidebar view and editor tabs.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ChatView, Controller } from "../controller";
import { HostToWebview, WebviewToHost } from "../../shared/protocol";

let counter = 0;

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "codicon.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
<title>Tellico</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function bind(webview: vscode.Webview, controller: Controller, view: ChatView): vscode.Disposable[] {
  return [
    controller.attach(view),
    webview.onDidReceiveMessage((msg: WebviewToHost) => void controller.handle(view, msg)),
  ];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  view?: ChatView & { webviewView: vscode.WebviewView };

  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: Controller) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const webview = webviewView.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    // Keep the session the sidebar showed across a hide/show.
    const previous = this.view?.sessionID ?? this.controller.rememberedSidebarSession;
    const view = {
      id: `sidebar-${++counter}`,
      sessionID: previous,
      sent: { length: 0 },
      webviewView,
      post: (msg: HostToWebview) => void webview.postMessage(msg),
      reveal: () => webviewView.show(true),
    };
    this.view = view;
    webview.html = html(webview, this.extensionUri);
    const subs = bind(webview, this.controller, view);
    webviewView.onDidDispose(() => subs.forEach((d) => d.dispose()));
  }
}

export function openChatTab(extensionUri: vscode.Uri, controller: Controller, sessionID?: string): ChatView {
  const panel = vscode.window.createWebviewPanel("tellico.chatTab", "Tellico", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "tellico.svg");
  const view: ChatView = {
    id: `tab-${++counter}`,
    sessionID,
    sent: { length: 0 },
    post: (msg) => {
      if (msg.type === "session") panel.title = msg.session.title || "Tellico";
      void panel.webview.postMessage(msg);
    },
    reveal: () => panel.reveal(),
  };
  panel.webview.html = html(panel.webview, extensionUri);
  const subs = bind(panel.webview, controller, view);
  panel.onDidDispose(() => subs.forEach((d) => d.dispose()));
  if (sessionID) void controller.openSession(view, sessionID);
  return view;
}
