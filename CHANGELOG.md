# Changelog

## Unreleased

- **Checkpoints**: rewind the files and conversation to before any message
  you sent (with Redo), edit and resend it, or fork from it.
- **Queue or steer** while a turn runs (`Enter` / `Ctrl+Enter`), with the
  queue shown above the input.
- **Phase line**: waiting for the model, running a tool, retrying with a
  countdown, or compacting; a context meter against the model's window with
  *Compact now*.
- **Composer**: `@` file completion with real attachments and line ranges,
  `!` shell commands, a draft per session, drop files from the Explorer,
  recall the last message with `↑`.
- **MCP**: a Tools panel (status, errors, on/off, OAuth sign-in, saved
  permissions), add or import servers into OpenCode's own config, and a
  built-in `vscode` MCP server for diagnostics, open editors and the
  selection. MCP and Code Mode calls render as such.
- **Attention**: badge, status bar and background notifications when Tellico
  waits for you or finishes; a worker's questions show in the lead's view;
  screen-reader announcements.
- **Editor**: *Fix with Tellico* / *Explain with Tellico* quick fixes, send
  terminal selection or the last terminal command, chat tabs restored after
  a reload, a first-run walkthrough.
- **History**: rename, pin, busy and unread state.
- **Fixes**: changed files cover the whole session, not only the latest turn;
  background subagents are off by default, like the launcher; queued prompts
  stay out of the transcript until delivered; one interrupt notice, with its
  reason; loop-guard notes read as notices; every launcher failure has a
  plain-language explanation; the first start no longer connects twice; the
  header's tok/s matches the turn footer.
- Settings for websearch, steps, loop guard and remote control.

- Smooth streaming: answers and reasoning are revealed at a steady,
  backlog-following pace like a chat app, instead of in the clusters the
  server's speculative decoding emits (and through the odd network pause).
  Measured in the webview: text advanced on every frame of a live answer,
  1-13 characters per frame, no pauses. `tellico.smoothStreaming` turns it
  off; reduced-motion is respected.

- Choose SSH tunnel or API gateway from the chat box, a command or
  `tellico.connection`; the gateway key is asked for once and stored with
  mode 600 beside the client's other keys. The status bar shows the
  connection. Needs `opencode-tellico --connection` from tellico-agentic-setup.

## 0.1.0 -- 2026-10-13

First release.

- Sidebar and editor-tab chat over `opencode-tellico serve` (OpenCode 2).
- Streaming text and reasoning, tool cards, slash commands, interrupt.
- build/orchestrate, node and thinking-level pickers.
- Workers panel with live status; worker transcripts in tabs.
- Changed files from the server's diffs, native diff editor, revert.
- Active-file attachment, `Alt+K` selection references.
- Permission and question cards; session history and resume; the sidebar
  reopens its last session after a reload.
- Design after the Claude Code and Codex panels: step timeline with status
  dots, "Thought for Ns" reasoning, inline edit diffs, highlighted code
  blocks with copy, an input box with agent/node/thinking menus, a workers
  and changed-files tray, and light, dark and high-contrast themes.
