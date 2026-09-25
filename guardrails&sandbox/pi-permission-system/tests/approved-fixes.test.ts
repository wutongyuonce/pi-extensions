import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSimpleYamlMap } from "../src/common.js";
import { DEFAULT_EXTENSION_CONFIG, LOGS_DIR_ENV_KEY, CONFIG_PATH_ENV_KEY } from "../src/extension-config.js";
import piPermissionSystemExtension, { processForwardedPermissionRequests, setExtensionConfig } from "../src/index.js";
import { createPermissionSystemLogger } from "../src/logging.js";
import {
  createPermissionForwardingLocation,
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
} from "../src/permission-forwarding.js";
import { compileWildcardPattern } from "../src/wildcard-matcher.js";
import {
  getPiPermissionSystemRuntimeApi,
  registerPiPermissionSystemRuntimeApi,
  unregisterPiPermissionSystemRuntimeApi,
  type PiPermissionSystemRuntimeApi,
} from "../src/yolo-mode-api.js";
import { createMockContext, runAsyncTest, runTest } from "./test-harness.js";

const ASK_BASH_POLICY = {
  tools: "allow",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
} as const;

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type Harness = {
  baseDir: string;
  cwd: string;
  handlers: Record<string, MockHandler>;
  prompts: string[];
  cleanup: () => Promise<void>;
};

function createHarness(baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-approved-fixes-runtime-"))): Harness {
  const cwd = join(baseDir, "workspace");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalConfigPath = process.env[CONFIG_PATH_ENV_KEY];
  const originalLogsDir = process.env[LOGS_DIR_ENV_KEY];
  const originalPolicyAgentDir = process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY];
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(baseDir, "pi-permissions.jsonc"),
    `${JSON.stringify({ defaultPolicy: ASK_BASH_POLICY }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(cwd, ".pi", "agent", "pi-permissions.jsonc"),
    `${JSON.stringify({ defaultPolicy: ASK_BASH_POLICY }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY] = baseDir;

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => [{ name: "bash" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: { emit: (): void => {} },
  } as never);

  return {
    baseDir,
    cwd,
    handlers,
    prompts,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, { sessionId: "approved-fixes-session" })));
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
      if (originalConfigPath === undefined) {
        delete process.env[CONFIG_PATH_ENV_KEY];
      } else {
        process.env[CONFIG_PATH_ENV_KEY] = originalConfigPath;
      }
      if (originalLogsDir === undefined) {
        delete process.env[LOGS_DIR_ENV_KEY];
      } else {
        process.env[LOGS_DIR_ENV_KEY] = originalLogsDir;
      }
      if (originalPolicyAgentDir === undefined) {
        delete process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY];
      } else {
        process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY] = originalPolicyAgentDir;
      }
    },
  };
}

async function runToolCall(
  harness: Harness,
  event: Record<string, unknown>,
  options: { hasUI?: boolean; selectResponse?: string } = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");
  const result = await Promise.resolve(
    handler(event, createMockContext(harness.cwd, harness.prompts, { sessionId: "approved-fixes-session", ...options })),
  );
  return (result ?? {}) as Record<string, unknown>;
}

runTest("yolo-mode runtime API register/get/unregister lifecycle respects mismatch guard", () => {
  unregisterPiPermissionSystemRuntimeApi();
  const apiA: PiPermissionSystemRuntimeApi = {
    getYoloMode: () => false,
    setYoloMode: () => ({ yoloMode: false, changed: false, persisted: false }),
    toggleYoloMode: () => ({ yoloMode: true, changed: true, persisted: false }),
  };
  const apiB: PiPermissionSystemRuntimeApi = {
    getYoloMode: () => true,
    setYoloMode: () => ({ yoloMode: true, changed: false, persisted: false }),
    toggleYoloMode: () => ({ yoloMode: false, changed: true, persisted: false }),
  };

  assert.equal(registerPiPermissionSystemRuntimeApi(apiA), apiA);
  assert.equal(getPiPermissionSystemRuntimeApi(), apiA);
  unregisterPiPermissionSystemRuntimeApi(apiB);
  assert.equal(getPiPermissionSystemRuntimeApi(), apiA, "unregister with a different API must be a no-op");
  unregisterPiPermissionSystemRuntimeApi(apiA);
  assert.equal(getPiPermissionSystemRuntimeApi(), null);

  registerPiPermissionSystemRuntimeApi(apiB);
  assert.equal(getPiPermissionSystemRuntimeApi(), apiB);
  unregisterPiPermissionSystemRuntimeApi();
  assert.equal(getPiPermissionSystemRuntimeApi(), null);
});

runTest("wildcard matcher documents platform-specific case sensitivity", () => {
  const pattern = compileWildcardPattern("Bash*", "allow");
  assert.equal(pattern.regex.test("Bash status"), true);
  assert.equal(
    pattern.regex.test("bash status"),
    process.platform === "win32",
    "wildcards are case-insensitive on Windows and case-sensitive on POSIX",
  );
});

runTest("frontmatter YAML parser drops prototype-pollution keys", () => {
  const parsed = parseSimpleYamlMap([
    "__proto__:",
    "  polluted: yes",
    "constructor:",
    "  prototype: unsafe",
    "permission:",
    "  __proto__:",
    "    tools: deny",
    "  tools:",
    "    read: allow",
  ].join("\n"));

  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.hasOwn(parsed, "constructor"), false);
  const permission = parsed.permission as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(permission), Object.prototype);
  assert.equal(Object.hasOwn(permission, "__proto__"), false);
  assert.deepEqual(permission.tools, { read: "allow" });
});

await runAsyncTest("review audit entries are written when debug logging is disabled without writing debug entries", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-review-logs-"));
  const logsDir = join(baseDir, "logs");
  const logPath = join(logsDir, "debug.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG, debug: false };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugPath: logPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    assert.equal(logger.debug("debug.disabled", { sample: true }), undefined);
    assert.equal(logger.review("permission_request.waiting", { toolName: "bash" }), undefined);
    await logger.flush();

    assert.equal(existsSync(logPath), true, "review logging should create the JSONL audit trail even when debug is false");
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /permission_request\.waiting/);
    assert.match(content, /"stream":"review"/);
    assert.doesNotMatch(content, /debug\.disabled/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("forwarded permission responses cannot escape the responses directory through request ids", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-forwarding-traversal-"));
  const sessionId = "approved-fixes-session";
  const originalForwardingAgentDir = process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
  process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = baseDir;
  const location = createPermissionForwardingLocation(join(baseDir, "sessions", "permission-forwarding"), sessionId);
  const prompts: string[] = [];

  try {
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    writeFileSync(
      join(location.requestsDir, "malicious.json"),
      JSON.stringify({
        id: "../requests/evil",
        responseNonce: "nonce",
        createdAt: Date.now(),
        requesterSessionId: "sub-session",
        targetSessionId: sessionId,
        requesterAgentName: "evil-agent",
        message: "Please approve traversal.",
      }),
      "utf8",
    );

    setExtensionConfig({ ...DEFAULT_EXTENSION_CONFIG, debug: false });
    await processForwardedPermissionRequests(
      createMockContext(baseDir, prompts, { sessionId, hasUI: true, selectResponse: "Allow Once" }) as never,
      { preserveLocation: true },
    );

    assert.equal(existsSync(join(location.requestsDir, "evil.json")), false);
    assert.equal(prompts.length, 0, "invalid forwarded request ids should be rejected before prompting the user");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    if (originalForwardingAgentDir === undefined) {
      delete process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
    } else {
      process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = originalForwardingAgentDir;
    }
  }
});

await runAsyncTest("Allow Always records a session-only approval and writes no persistent file", async () => {
  const harness = createHarness();
  const approvalsPath = join(harness.baseDir, "pi-permission-system-approvals.json");

  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, createMockContext(harness.cwd, harness.prompts, { sessionId: "approved-fixes-session", hasUI: true })));
    const first = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "approved-fixes-always-first",
        input: { command: "git status --short" },
      },
      { hasUI: true, selectResponse: "Allow Always" },
    );

    assert.deepEqual(first, {});
    assert.equal(existsSync(approvalsPath), false, "Allow Always must not persist a permanent approval file");

    // A repeat identical call within the same session should be auto-approved by the session store.
    const second = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "approved-fixes-always-second",
        input: { command: "git status --short" },
      },
      { hasUI: true, selectResponse: "Allow Always" },
    );
    assert.deepEqual(second, {}, "Session approval should auto-allow the repeated command without a new prompt");
  } finally {
    await harness.cleanup();
    rmSync(harness.baseDir, { recursive: true, force: true });
  }
});

console.log("Approved audit fix tests passed.");
