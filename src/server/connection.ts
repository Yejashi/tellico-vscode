// Which way the models are reached: over the user's SSH tunnel, or through
// the API gateway with a per-user key. tellico-agentic-setup records one mode
// at install time; `opencode-tellico --connection` (TELLICO_CONNECTION) runs
// a launch over either. This module only knows where the launcher keeps its
// files -- the key file rule mirrors tellico_key_file in lib/checks.sh.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Connection = "tunnel" | "gateway";
export type ConnectionSetting = "installed" | Connection;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tellico-qwen");
}

/** The mode install.sh recorded in client.env; tunnel when unreadable, as the scripts assume. */
export function installedMode(dir = configDir()): Connection {
  try {
    const m = /^TELLICO_MODE='?(tunnel|gateway)'?\s*$/m.exec(readFileSync(join(dir, "client.env"), "utf8"));
    return (m?.[1] as Connection) ?? "tunnel";
  } catch {
    return "tunnel";
  }
}

export function effectiveConnection(setting: ConnectionSetting, dir = configDir()): Connection {
  return setting === "installed" ? installedMode(dir) : setting;
}

/** The installed mode keeps api-key; the other connection uses api-key.<mode>. */
export function keyFile(connection: Connection, dir = configDir()): string {
  return join(dir, connection === installedMode(dir) ? "api-key" : `api-key.${connection}`);
}

export function hasKey(connection: Connection, dir = configDir()): boolean {
  try {
    return statSync(keyFile(connection, dir)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Stores a gateway key where the launcher reads it: mode 0600, written to a
 * temporary file first so a crash never leaves a truncated key behind.
 */
export function writeGatewayKey(key: string, dir = configDir()): string {
  const clean = key.replace(/[\r\n]/g, "").trim();
  if (!clean) throw new Error("The API key is empty.");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = keyFile("gateway", dir);
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}
