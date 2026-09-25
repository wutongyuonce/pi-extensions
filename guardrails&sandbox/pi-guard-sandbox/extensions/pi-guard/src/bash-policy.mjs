const DETECTORS = {
  sudo: /(^|\s)sudo(\s|$)/i,
  su: /(^|\s)su(\s|$)/i,
  mount: /(^|\s)mount(\s|$)/i,
  umount: /(^|\s)umount(\s|$)/i,
  mkfs: /(^|\s)mkfs(?:\.\w+)?(\s|$)/i,
  dd: /(^|\s)dd(\s|$)/i,
  "docker-host-root-bind": /docker\s+run[\s\S]*?(?:-v|--volume)\s*[:=]?\s*\/:\/host(?:\s|$)|docker\s+run[\s\S]*?(?:-v|--volume)\s*[:=]?\s*\/\s*:\s*\/host(?:\s|$)/i,
  "curl-pipe-sh": /curl[\s\S]*\|\s*sh(\s|$)/i,
  "curl-pipe-bash": /curl[\s\S]*\|\s*bash(\s|$)/i,
  "wget-pipe-sh": /wget[\s\S]*\|\s*sh(\s|$)/i,
  "wget-pipe-bash": /wget[\s\S]*\|\s*bash(\s|$)/i,
  "rm-rf": /rm\s+[\s\S]*-(?:[^\n\r]*r[^\n\r]*f|[^\n\r]*f[^\n\r]*r|r|f)(\s|$)/i,
  "git-reset-hard": /git\s+reset\s+--hard(\s|$)/i,
  "git-clean-fd": /git\s+clean\s+-fd(\s|$)/i,
  "git-clean-xdf": /git\s+clean\s+-xdf(\s|$)/i,
  "chmod-r": /chmod\s+-R(\s|$)/i,
  "chown-r": /chown\s+-R(\s|$)/i,
  "bash-c": /(^|\s)bash\s+-c(\s|$)/i,
  "sh-c": /(^|\s)sh\s+-c(\s|$)/i,
};

const LABELS = {
  sudo: "sudo",
  su: "su",
  mount: "mount",
  umount: "umount",
  mkfs: "mkfs",
  dd: "dd",
  "docker-host-root-bind": "docker run with host root bind mount",
  "curl-pipe-sh": "curl | sh",
  "curl-pipe-bash": "curl | bash",
  "wget-pipe-sh": "wget | sh",
  "wget-pipe-bash": "wget | bash",
  "rm-rf": "rm -rf",
  "git-reset-hard": "git reset --hard",
  "git-clean-fd": "git clean -fd",
  "git-clean-xdf": "git clean -xdf",
  "chmod-r": "chmod -R",
  "chown-r": "chown -R",
  "bash-c": "bash -c",
  "sh-c": "sh -c",
};

function firstMatch(command, ids) {
  for (const id of ids) {
    const pattern = DETECTORS[id];
    if (pattern?.test(command)) return id;
  }
  return null;
}

export function classifyBashCommand(command, bashPolicy) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return { status: "block", reason: "Empty bash command." };
  const directMatch = firstMatch(trimmed, bashPolicy.directBlock ?? []);
  if (directMatch) {
    return {
      status: "block",
      policyId: directMatch,
      reason: `Blocked dangerous command: ${LABELS[directMatch] ?? directMatch}.`,
    };
  }

  const approvalMatch = firstMatch(trimmed, bashPolicy.requireApproval ?? []);
  if (approvalMatch) {
    return {
      status: "approval",
      policyId: approvalMatch,
      reason: `Approval required for ${LABELS[approvalMatch] ?? approvalMatch}.`,
    };
  }

  return { status: "allow" };
}
