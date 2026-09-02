import { classifyBashCommand } from "./bash-policy.mjs";
import {
  canonicalizeTargetPath,
  getWorkspaceRoot,
  isInsideRoot,
  matchesPathOrDescendant,
  matchesWorkspacePattern,
  normalizeSlashes,
  toWorkspaceRelative,
} from "./path-utils.mjs";
import { getGuardConfigPath } from "./config.mjs";

function makeDecision(decision) {
  return { ...decision, block: decision.status === "block" };
}

function findSensitivePattern(pathname, patterns) {
  return patterns.find((pattern) => matchesPathOrDescendant(pathname, pattern));
}

function findProtectedPattern(relativePath, patterns) {
  return patterns.find((pattern) => matchesWorkspacePattern(relativePath, pattern));
}

function getTargetPath(cwd, rawPath) {
  const target = canonicalizeTargetPath(cwd, rawPath);
  if (!target) {
    return { ok: false, reason: `Could not resolve path: ${rawPath}` };
  }
  return { ok: true, target };
}

export async function evaluateToolCall({ cwd, config, statusKind, toolName, input, hasUI, requestApproval }) {
  if (!config) return { status: "allow" };

  if (toolName === "bash") {
    if (statusKind === "sandbox-unavailable") {
      return makeDecision({ status: "block", reason: "Guard bash sandbox is unavailable." });
    }
    const result = classifyBashCommand(String(input.command ?? ""), config.bashPolicy);
    if (result.status !== "approval") return makeDecision(result);
    if (!hasUI) {
      return makeDecision({ status: "block", reason: `${result.reason} No UI available for approval.` });
    }
    const approved = await requestApproval?.({
      type: "bash",
      title: "Allow dangerous bash command?",
      body: `${result.reason}\n\n${String(input.command ?? "")}`,
    });
    return approved ? { status: "allow" } : makeDecision({ status: "block", reason: "User denied dangerous bash command." });
  }

  if (toolName !== "read" && toolName !== "write" && toolName !== "edit") {
    return { status: "allow" };
  }

  const rawPath = String(input.path ?? "").trim();
  if (!rawPath) return makeDecision({ status: "block", reason: `${toolName} missing path.` });

  const resolved = getTargetPath(cwd, rawPath);
  if (!resolved.ok) return makeDecision({ status: "block", reason: resolved.reason });

  const workspaceRoot = getWorkspaceRoot(cwd);
  const target = resolved.target;
  const isInsideWorkspace = isInsideRoot(workspaceRoot, target);
  const relativePath = isInsideWorkspace ? normalizeSlashes(toWorkspaceRelative(workspaceRoot, target)) : null;
  const sensitivePattern = findSensitivePattern(target, config.sensitiveReadDeny);

  if (toolName === "read") {
    if (sensitivePattern) {
      return makeDecision({ status: "block", reason: `Sensitive read denied by ${sensitivePattern}.` });
    }
    return { status: "allow" };
  }

  if (config.mode === "readonly") {
    return makeDecision({ status: "block", reason: `${toolName} is denied in read-only mode.` });
  }

  if (relativePath) {
    const blockedPattern = findProtectedPattern(relativePath, config.protectedPaths.block);
    if (blockedPattern) {
      return makeDecision({ status: "block", reason: `Protected path blocked by ${blockedPattern}.` });
    }

    const approvalPattern = findProtectedPattern(relativePath, config.protectedPaths.approval);
    if (!approvalPattern) return { status: "allow" };

    if (!hasUI) {
      return makeDecision({ status: "block", reason: `Protected path ${relativePath} requires approval, but no UI is available.` });
    }

    const approved = await requestApproval?.({
      type: toolName,
      title: `Allow ${toolName} to protected path?`,
      body: `${toolName} -> ${relativePath}\nRule: ${approvalPattern}`,
    });
    return approved ? { status: "allow" } : makeDecision({ status: "block", reason: `User denied ${toolName} to protected path.` });
  }

  if (!hasUI) {
    return makeDecision({ status: "block", reason: `External ${toolName} requires approval, but no UI is available.` });
  }

  const configPath = getGuardConfigPath(cwd);
  const approved = await requestApproval?.({
    type: toolName,
    title: `Allow ${toolName} outside workspace?`,
    body: `${toolName} -> ${target}${target === configPath ? "\n(Guard config path)" : ""}`,
  });
  return approved ? { status: "allow" } : makeDecision({ status: "block", reason: `User denied external ${toolName}.` });
}
