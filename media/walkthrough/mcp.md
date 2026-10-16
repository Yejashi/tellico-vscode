# MCP

The built-in `vscode` server lets the agent read VS Code's **diagnostics**,
**open editors** and **selection** (Settings → `tellico.ideTools`).

**Add MCP Server…** writes to your own OpenCode config (the project's
`opencode.json` or the global one), like `opencode mcp add`.
**Import from VS Code** copies servers from `.vscode/mcp.json`;
`${env:X}` becomes OpenCode's `{env:X}`, so tokens stay out of the file.

Each tool's description is sent with **every** request against Tellico's
131k-token context, and secret-guard does not inspect MCP tools: add only
what you need.
