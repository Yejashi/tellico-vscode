# Changelog

## Unreleased

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
