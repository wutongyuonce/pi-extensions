import { join } from "node:path";
import { getWorkspaceRoot, normalizeSensitivePathPattern } from "./path-utils.mjs";

export function buildSandboxRuntimeConfig({ cwd, config }) {
  const workspaceRoot = getWorkspaceRoot(cwd);
  const configPath = join(workspaceRoot, ".pi", "pi-guard.json");
  const denyWrite = [configPath];
  const allowWrite = config.mode === "readonly" ? ["/tmp"] : [workspaceRoot, "/tmp"];

  const networkBlocked = config.network === "blocked";

  return {
    network: {
      allowedDomains: networkBlocked ? [] : undefined,
      deniedDomains: [],
      allowAllUnixSockets: true,
    },
    filesystem: {
      denyRead: [...new Set(config.sensitiveReadDeny.map((pattern) => normalizeSensitivePathPattern(pattern)))],
      allowWrite,
      denyWrite,
      allowRead: config.mode === "workspace-write" ? [workspaceRoot] : undefined,
    },
    enableWeakerNestedSandbox: true,
    allowGitConfig: true,
    ripgrep: {
      command: "rg",
    },
  };
}
