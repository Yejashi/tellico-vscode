# Two ways in

**SSH tunnel** uses your cluster account: the launcher brings the tunnel up
and fetches the cluster key, exactly like `opencode-tellico` in a terminal.

**API gateway** needs only a per-user key and no SSH. The key is stored in
`~/.config/tellico-qwen` with mode 600, never in VS Code settings.

Switching restarts the server; sessions carry over. The status bar shows
which one is in use.
