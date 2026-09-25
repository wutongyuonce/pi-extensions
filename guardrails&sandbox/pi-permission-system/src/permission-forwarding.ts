import { join } from "node:path";

import { getNonEmptyString, normalizeAgentName } from "./common.js";
import type { PermissionDecisionState } from "./permission-dialog.js";

export const PERMISSION_FORWARDING_POLL_INTERVAL_MS = 2_000;
export const PERMISSION_FORWARDING_WATCH_DEBOUNCE_MS = 25;
export const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;
export const SUBAGENT_ENV_HINT_KEYS = ["PI_IS_SUBAGENT", "PI_SUBAGENT_SESSION_ID", "PI_AGENT_ROUTER_SUBAGENT"] as const;
export const SUBAGENT_PARENT_SESSION_ENV_KEY = "PI_AGENT_ROUTER_PARENT_SESSION_ID";
export const PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR";
export const PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY = "PI_DELEGATED_AUTH_RUNTIME_DIR";
export const PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY = "PI_MULTI_AUTH_RUNTIME_DIR";
export const PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";

const PERMISSION_FORWARDING_DIRECTORY_NAME = "permission-forwarding";
const SESSION_FORWARDING_ROOT_DIRECTORY_NAME = "sessions";
const SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME = "requests";
const SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME = "responses";

export type ForwardedPermissionRequest = {
  id: string;
  responseNonce: string;
  createdAt: number;
  requesterSessionId: string;
  targetSessionId: string;
  requesterAgentName: string;
  message: string;
};

export type ForwardedPermissionResponse = {
  requestId: string;
  responseNonce: string;
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  responderSessionId: string;
  respondedAt: number;
};

export type PermissionForwardingLocation = {
  sessionId: string;
  sessionRootDir: string;
  requestsDir: string;
  responsesDir: string;
  label: "primary";
};

export function normalizePermissionForwardingSessionId(value: unknown): string | null {
  const trimmed = getNonEmptyString(value);
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return null;
  }

  return trimmed;
}

function encodeSessionIdForPath(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function resolvePermissionForwardingRootDir(options: {
  defaultAgentDir: string;
  isSubagent: boolean;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  const explicitAgentDir = normalizeAgentName(
    env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY],
  );
  const delegatedRuntimeAgentDir = options.isSubagent
    ? normalizeAgentName(env[PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY])
    : null;
  const routerSharedAgentDir = options.isSubagent
    ? normalizeAgentName(env[PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY])
    : null;
  const policyAgentDir = options.isSubagent
    ? normalizeAgentName(env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY])
    : null;

  // Router-launched subagents run with an isolated PI_CODING_AGENT_DIR, so
  // prefer shared parent-runtime hints for request/response IPC before falling
  // back to the isolated agent directory.
  const agentDir = explicitAgentDir
    ?? delegatedRuntimeAgentDir
    ?? routerSharedAgentDir
    ?? policyAgentDir
    ?? options.defaultAgentDir;

  return join(agentDir, SESSION_FORWARDING_ROOT_DIRECTORY_NAME, PERMISSION_FORWARDING_DIRECTORY_NAME);
}

export function createPermissionForwardingLocation(
  forwardingRootDir: string,
  sessionId: string,
): PermissionForwardingLocation {
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("Permission forwarding session id must be a non-empty string.");
  }

  const sessionRootDir = join(
    forwardingRootDir,
    SESSION_FORWARDING_ROOT_DIRECTORY_NAME,
    encodeSessionIdForPath(normalizedSessionId),
  );

  return {
    sessionId: normalizedSessionId,
    sessionRootDir,
    requestsDir: join(sessionRootDir, SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME),
    responsesDir: join(sessionRootDir, SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME),
    label: "primary",
  };
}

export function resolvePermissionForwardingTargetSessionId(options: {
  hasUI: boolean;
  isSubagent: boolean;
  currentSessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}): string | null {
  if (options.hasUI) {
    return normalizePermissionForwardingSessionId(options.currentSessionId);
  }

  if (!options.isSubagent) {
    return null;
  }

  return normalizePermissionForwardingSessionId(
    options.env?.[SUBAGENT_PARENT_SESSION_ENV_KEY],
  );
}

export function isForwardedPermissionRequestForSession(
  request: Pick<ForwardedPermissionRequest, "targetSessionId">,
  sessionId: string | null | undefined,
): boolean {
  const normalizedRequestSessionId = normalizePermissionForwardingSessionId(request.targetSessionId);
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  return normalizedRequestSessionId !== null && normalizedRequestSessionId === normalizedSessionId;
}
