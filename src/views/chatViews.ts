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
  private waiting = 0;

  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: Controller) {
    // Questions waiting for an answer show as a count on the Tellico icon.
    controller.onWaiting((n) => {
      this.waiting = n;
      this.applyBadge();
    });
  }

  private applyBadge() {
    const v = this.view?.webviewView;
    if (v) v.badge = this.waiting ? { value: this.waiting, tooltip: `${this.waiting} question${this.waiting > 1 ? "s" : ""} waiting for you` } : undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const webview = webviewView.webview;
    // Content first: options set on an empty webview load a document with no CSP.
    webview.html = html(webview, this.extensionUri);
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
    const subs = bind(webview, this.controller, view);
    webviewView.onDidDispose(() => subs.forEach((d) => d.dispose()));
    this.applyBadge();
  }
}

const TAB_OPTIONS = (extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions => ({
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
});

/** Opens a chat in an editor tab, or adopts one VS Code restored after a reload. */
export function openChatTab(extensionUri: vscode.Uri, controller: Controller, sessionID?: string, restored?: vscode.WebviewPanel): ChatView {
  const panel =
    restored ?? vscode.window.createWebviewPanel(TAB_VIEW_TYPE, "Tellico", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, TAB_OPTIONS(extensionUri));
  if (restored) panel.webview.options = TAB_OPTIONS(extensionUri);
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
  // A restored tab's webview asks for its session itself once it is ready.
  if (sessionID && !restored) void controller.openSession(view, sessionID);
  return view;
}

export const TAB_VIEW_TYPE = "tellico.chatTab";

/** Brings chat tabs back after a reload; the webview saved its session id in its state. */
export class TabSerializer implements vscode.WebviewPanelSerializer {
  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: Controller, private readonly adopt: (v: ChatView) => void) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
    const id = typeof (state as any)?.sessionID === "string" ? (state as any).sessionID : undefined;
    this.adopt(openChatTab(this.extensionUri, this.controller, id, panel));
  }
}
