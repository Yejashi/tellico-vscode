// Tells the user when Tellico needs them or has finished, without them
// watching the panel: a badge on the Tellico view for pending questions, and
// a notification when a turn ends or a permission is asked while the window
// is in the background. Local runs are long; this is what lets you look away.

import * as vscode from "vscode";
import type { SessionView } from "../shared/model";

export type NotifyWhen = "unfocused" | "always" | "off";

export class Attention {
  private readonly wasBusy = new Set<string>();
  private readonly asked = new Set<string>();

  constructor(
    private readonly setting: () => NotifyWhen,
    private readonly open: (sessionID: string) => void,
  ) {}

  /** Pending permission requests and questions across every known session. */
  waiting(sessions: Iterable<SessionView>): number {
    let n = 0;
    for (const s of sessions) n += s.permissions.length + s.forms.length;
    return n;
  }

  /** Called after each batch of store changes, for the sessions that changed. */
  update(changed: SessionView[], all: () => Iterable<SessionView>) {
    for (const s of changed) {
      if (s.parentID) continue;
      if (s.status === "busy") this.wasBusy.add(s.id);
      else if (this.wasBusy.delete(s.id)) this.finished(s);
    }
    for (const s of all()) {
      for (const p of [...s.permissions.map((x) => x.id), ...s.forms.map((x) => x.id)]) {
        if (this.asked.has(p)) continue;
        this.asked.add(p);
        this.needsInput(s);
      }
    }
  }

  private shouldNotify(): boolean {
    const when = this.setting();
    return when === "always" || (when === "unfocused" && !vscode.window.state.focused);
  }

  private finished(s: SessionView) {
    if (!this.shouldNotify()) return;
    const failed = s.status === "error";
    const show = failed ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`Tellico ${failed ? "stopped with an error" : "finished"}: ${s.title}`, "Open").then((pick) => pick && this.open(s.id));
  }

  private needsInput(s: SessionView) {
    if (!this.shouldNotify()) return;
    const lead = s.parentID ?? s.id;
    void vscode.window
      .showWarningMessage(`Tellico is waiting for you${s.parentID ? " (a worker)" : ""}: ${s.title}`, "Open")
      .then((pick) => pick && this.open(lead));
  }
}
