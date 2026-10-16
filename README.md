# Tellico for VS Code

A chat sidebar for the Tellico Qwen setup: the same agents, plugins, workers
and Magic Context as `opencode-tellico`, in VS Code instead of a terminal.

<p align="center">
  <img src="docs/welcome.png" width="320" alt="Tellico welcome screen with suggestions">
  &nbsp;
  <img src="docs/session.png" width="320" alt="An orchestrate session: a worker dispatched, its completion, and the changed-files tray">
</p>

- **Streaming chat** in the sidebar or in editor tabs (`Ctrl+Shift+Esc`),
  paced like a chat app so text flows steadily over SSH or the gateway, with
  collapsible reasoning and a card per tool call.
- **build / orchestrate**, **node 0 / 1** and **thinking level** pickers, the
  same choices as `opencode-tellico [0|1] [--orchestrate] [--think LEVEL]`.
- **Workers panel**: every subagent the lead dispatches, with live status;
  click one to read its transcript.
- **Changed files**: per session, including workers' edits, with VS Code's own
  diff editor and a one-click revert.
- **Editor context**: the active file is attached to each message (toggle the
  chip); `Alt+K` inserts an `@file#Lx-y` reference to the selection.
- **Slash commands** from the server, including Magic Context's `/ctx-*`, and
  `/think-off|low|medium|xhigh`.
- **Permission and question cards** when an agent asks.
- **History**: resume any session, including ones started in the terminal.
  Sessions live in OpenCode's own store, so both see the same list.

## How it works

The extension does not reimplement anything. It starts
`opencode-tellico serve` for the open folder (one private OpenCode 2 server
per window, on a random loopback port, with a random password), and talks to
its HTTP API and event stream. Everything Tellico-specific -- the lead node,
agents, prompts, plugins, Magic Context, the tunnel or gateway -- comes from
the installed [tellico-agentic-setup] client, so the terminal and VS Code
cannot drift apart.

```
VS Code ──HTTP+SSE──▶ opencode-tellico serve ──▶ Tellico (tunnel or gateway)
```

## Requirements

- **OpenCode 2** (`opencode --version` ≥ 2.0). OpenCode 1's server API is
  different and not supported yet.
- **The Tellico client**, installed from [tellico-agentic-setup] *after*
  `opencode-tellico serve` was added:
  - with a cluster account: `./install.sh`
  - with only an API key: `./install.sh --gateway` and paste the key
- Linux, macOS, WSL or a Remote-SSH host (the launcher is POSIX sh). The
  extension runs on the machine where the code and the client are; under
  Remote-SSH, install it on the remote side.

Check the client with `./doctor.sh` in the tellico-agentic-setup checkout.

## Install

Download the `.vsix` from the [releases] page, then:

```sh
code --install-extension tellico-vscode-<version>.vsix
```

Open a folder, click the Tellico icon in the activity bar, and type.

## Settings

| Setting | Default | |
|---|---|---|
| `tellico.launcherPath` | `opencode-tellico` | Found on `PATH` or in `~/.local/bin`. |
| `tellico.connection` | `installed` | `tunnel` (SSH), `gateway` (API key) or whatever `./install.sh` set up. |
| `tellico.gatewayUrl` | empty | Gateway base URL; empty uses the one `./install.sh` recorded. |
| `tellico.leadNode` | `auto` | `auto` derives a stable node from this device, like the launcher. |
| `tellico.defaultMode` | `build` | `orchestrate` lets the lead delegate to the two workers. |
| `tellico.defaultThink` | `medium` | Starting thinking level for new sessions. |
| `tellico.magicContext` | `true` | Off = `--no-magic-context`. |
| `tellico.backgroundSubagents` | `false` | Dispatch workers in the background. Off by default, like the launcher. |
| `tellico.attachActiveEditor` | `true` | Attach the active file to each message. |
| `tellico.showReasoning` | `false` | Expand reasoning blocks by default. |
| `tellico.smoothStreaming` | `true` | Pace streamed text steadily instead of showing token clusters as they land. |

Changing a server setting offers to restart the server.

## SSH or API key

Pick how the models are reached from the plug icon in the chat box, the
**Tellico: Switch Connection** command, or `tellico.connection`; the status
bar shows which is in use (`· SSH` / `· gateway`). Switching restarts the
server, and sessions carry over.

- **SSH tunnel** uses your cluster account, exactly like a tunnel-mode
  install: the launcher brings the tunnel up and fetches the cluster key.
- **API gateway** uses a per-user key and no SSH. The first time, the
  extension asks for the key (**Tellico: Set Gateway API Key** changes it
  later) and stores it in `~/.config/tellico-qwen` with mode 600 -- the
  same place the launcher and `./install.sh --gateway` keep keys, guarded by
  the same secret guards. It is never put in VS Code settings.

Each connection keeps its own key file, so switching never overwrites the
other one. Under the hood this is `opencode-tellico --connection
tunnel|gateway`, which needs a tellico-agentic-setup install from after that
flag was added (`./install.sh --no-start` updates one).

## Keys

| Key | |
|---|---|
| `Ctrl+Esc` | Focus the chat |
| `Ctrl+Shift+Esc` | Open a chat in a new editor tab |
| `Alt+K` | Reference the selection in the composer |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Stop the running turn |

## Troubleshooting

- **"The installed opencode-tellico predates serve mode"**: run
  `./install.sh --no-start` in tellico-agentic-setup.
- **Server fails to start**: *Tellico: Show Server Logs* shows the launcher's
  own output (tunnel, gateway and config errors appear there first).
- **Thinking level seems to have no effect**: update the client
  (`./install.sh --no-start` in tellico-agentic-setup); installs from before
  2026-10-13 lose it on OpenCode 2.

## Known limitations

- One server per window, for the first workspace folder.

## Development

```sh
npm install
npm run build          # or: npm run watch
npm test               # unit tests, driven by recorded server events
npm run typecheck
```

Press `F5` in VS Code to launch an Extension Development Host. The live
end-to-end test uses a real cluster slot and is skipped unless asked for:

```sh
TELLICO_LIVE=1 npx vitest run test/live.test.ts
```

`npm run package` builds `tellico-vscode-<version>.vsix`. Tag `vX.Y.Z` to
have CI attach it to a GitHub release.

[tellico-agentic-setup]: https://github.com/Yejashi/tellico-agentic-setup
[releases]: https://github.com/Yejashi/tellico-vscode/releases
