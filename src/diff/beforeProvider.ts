import * as vscode from "vscode";

export const BEFORE_SCHEME = "tellico-before";

/** Serves the pre-session text of a file as a read-only virtual document. */
export class BeforeContentProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(relPath: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: "/" + relPath });
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }
}
