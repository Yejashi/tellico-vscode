import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveConnection, hasKey, installedMode, keyFile, writeGatewayKey } from "../src/server/connection";

const dir = (clientEnv?: string) => {
  const d = mkdtempSync(join(tmpdir(), "tellico-conn-"));
  if (clientEnv !== undefined) writeFileSync(join(d, "client.env"), clientEnv);
  return d;
};

describe("connection", () => {
  it("reads the installed mode the way install.sh writes it", () => {
    expect(installedMode(dir("TELLICO_MODE='gateway'\nTELLICO_SSH_HOST='tellico'\n"))).toBe("gateway");
    expect(installedMode(dir("TELLICO_MODE='tunnel'\n"))).toBe("tunnel");
    expect(installedMode(dir())).toBe("tunnel");
  });

  it("follows the launcher's key file rule (lib/checks.sh tellico_key_file)", () => {
    const tunnelInstall = dir("TELLICO_MODE='tunnel'\n");
    expect(keyFile("tunnel", tunnelInstall)).toBe(join(tunnelInstall, "api-key"));
    expect(keyFile("gateway", tunnelInstall)).toBe(join(tunnelInstall, "api-key.gateway"));
    const gatewayInstall = dir("TELLICO_MODE='gateway'\n");
    expect(keyFile("gateway", gatewayInstall)).toBe(join(gatewayInstall, "api-key"));
    expect(keyFile("tunnel", gatewayInstall)).toBe(join(gatewayInstall, "api-key.tunnel"));
  });

  it("resolves 'installed' to the recorded mode", () => {
    expect(effectiveConnection("installed", dir("TELLICO_MODE='gateway'\n"))).toBe("gateway");
    expect(effectiveConnection("tunnel", dir("TELLICO_MODE='gateway'\n"))).toBe("tunnel");
  });

  it("writes the gateway key trimmed and private, beside a tunnel install's own key", () => {
    const d = dir("TELLICO_MODE='tunnel'\n");
    writeFileSync(join(d, "api-key"), "cluster-key", { mode: 0o600 });
    expect(hasKey("gateway", d)).toBe(false);
    const path = writeGatewayKey("  user-key\n", d);
    expect(path).toBe(join(d, "api-key.gateway"));
    expect(readFileSync(path, "utf8")).toBe("user-key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, "api-key"), "utf8")).toBe("cluster-key");
    expect(hasKey("gateway", d)).toBe(true);
  });

  it("rejects an empty key", () => {
    expect(() => writeGatewayKey(" \n", dir())).toThrow(/empty/);
  });
});
