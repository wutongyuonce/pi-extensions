export const GUARD_CONFIG_RELATIVE_PATH = ".pi/pi-guard.json";

export const DEFAULT_SENSITIVE_READ_DENY = [
  "~/.ssh", "~/.aws", "~/.gnupg", "~/.git-credentials", "~/.env", "~/.env.*",
  "~/.npmrc", "~/.pypirc", "~/.netrc", "/mnt/c/Users/*/.ssh",
];

export const DEFAULT_PROTECTED_PATHS = {
  block: [".git", "node_modules"],
  approval: [".env", ".env.*", ".pi/pi-guard.json"],
};

export const DEFAULT_BASH_POLICY = {
  directBlock: ["sudo", "su", "mount", "umount", "mkfs", "dd", "docker-host-root-bind", "curl-pipe-sh", "curl-pipe-bash", "wget-pipe-sh", "wget-pipe-bash"],
  requireApproval: ["rm-rf", "git-reset-hard", "git-clean-fd", "git-clean-xdf", "chmod-r", "chown-r", "bash-c", "sh-c"],
};

export const DEFAULT_DCG = {
  enabled: true,
  onDeny: "confirm",
  onIndeterminate: "notify",
  onError: "notify",
};

export const DEFAULT_NETWORK_ALLOWLIST = [
  "github.com", "*.github.com", "api.github.com", "raw.githubusercontent.com", "npmjs.org", "*.npmjs.org", "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "*.pypi.org",
];

export function createDefaultConfig() {
  return {
    enabled: true,
    sandbox: { enabled: true },
    mode: "workspace-write",
    network: "open",
    dcg: { ...DEFAULT_DCG },
    sensitiveReadDeny: [...DEFAULT_SENSITIVE_READ_DENY],
    protectedPaths: { block: [...DEFAULT_PROTECTED_PATHS.block], approval: [...DEFAULT_PROTECTED_PATHS.approval] },
    bashPolicy: { directBlock: [...DEFAULT_BASH_POLICY.directBlock], requireApproval: [...DEFAULT_BASH_POLICY.requireApproval] },
  };
}
