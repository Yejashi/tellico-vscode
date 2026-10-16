// Smoke test inside a real VS Code: the extension activates, every command
// in package.json is registered, and the chat view and a chat tab open.
// Run with `npm run test:vscode` (opens a throwaway VS Code window).

const vscode = require("vscode");
const assert = require("node:assert");

const report = (line) => {
  console.log(line);
  if (process.env.TELLICO_SMOKE_OUT) require("node:fs").appendFileSync(process.env.TELLICO_SMOKE_OUT, line + "\n");
};

exports.run = async function run() {
  try {
    await check();
  } catch (err) {
    report(`tellico smoke: FAILED ${err && err.stack ? err.stack : err}`);
    throw err;
  }
};

async function check() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "tellico-vscode");
  assert.ok(ext, "extension not found");
  await ext.activate();
  const all = new Set(await vscode.commands.getCommands(true));
  const missing = ext.packageJSON.contributes.commands.map((c) => c.command).filter((c) => !all.has(c));
  assert.deepStrictEqual(missing, [], `commands not registered: ${missing}`);
  await vscode.commands.executeCommand("tellico.focus");
  await vscode.commands.executeCommand("tellico.openInTab");
  await new Promise((r) => setTimeout(r, Number(process.env.TELLICO_SMOKE_WAIT ?? 1500)));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview);
  assert.ok(tabs.some((t) => t.label === "Tellico"), "chat tab did not open");
  report(`tellico smoke: ok (${ext.packageJSON.contributes.commands.length} commands, VS Code ${vscode.version})`);
}
