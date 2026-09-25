import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
  type PermissionSystemExtensionConfig,
} from "../src/extension-config.js";
import piPermissionSystemExtension from "../src/index.js";
import {
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import type { GlobalPermissionConfig, PermissionDefaultPolicy } from "../src/types.js";
import { createMockContext } from "./test-harness.js";

type ExpectedKind = "red" | "regression";

type IssueTest = {
  name: string;
  kind: ExpectedKind;
  scenario: string;
  fn: () => void | Promise<void>;
};

type TestResult = {
  name: string;
  kind: ExpectedKind;
  status: "PASS" | "FAIL";
  error?: unknown;
};

const ISOLATED_ENV_KEYS = [
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  ...SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
] as const;

for (const key of ISOLATED_ENV_KEYS) {
  delete process.env[key];
}

const ASK_BASH_POLICY: PermissionDefaultPolicy = {
  tools: "allow",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type RuntimeHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  debugPath: string;
  cleanup: () => Promise<void>;
};

type RuntimeHarnessOptions = {
  cwd?: string;
  extensionConfig?: PermissionSystemExtensionConfig;
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string;
  activeAgentName?: string | null;
};

function createRuntimeHarness(
  config: GlobalPermissionConfig,
  toolNames: readonly string[],
  options: RuntimeHarnessOptions = {},
): RuntimeHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue26-runtime-"));
  const cwd = options.cwd ?? join(baseDir, "workspace");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
  const debugPath = join(logsDir, "pi-permission-system-debug.jsonl");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalConfigPath = process.env[CONFIG_PATH_ENV_KEY];
  const originalLogsDir = process.env[LOGS_DIR_ENV_KEY];

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(baseDir, "pi-permissions.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeFileSync(
    extensionConfigPath,
    `${JSON.stringify(options.extensionConfig ?? DEFAULT_EXTENSION_CONFIG, null, 2)}\n`,
    "utf8",
  );

  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => toolNames.map((name) => ({ name })),
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return {
    baseDir,
    cwd,
    prompts,
    handlers,
    debugPath,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, { sessionId: "issue-26-session", ...options })));
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
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

async function runLifecycle(
  harness: RuntimeHarness,
  eventName: "session_start" | "resources_discover",
  event: Record<string, unknown>,
  options: RuntimeHarnessOptions = {},
): Promise<void> {
  const handler = harness.handlers[eventName];
  assert.equal(typeof handler, "function");
  await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, { sessionId: "issue-26-session", ...options })));
}

async function runToolCall(
  harness: RuntimeHarness,
  event: Record<string, unknown>,
  options: RuntimeHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");
  const result = await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, { sessionId: "issue-26-session", ...options })));
  return (result ?? {}) as Record<string, unknown>;
}

function readDebugLogLines(debugPath: string): Array<Record<string, unknown>> {
  if (!existsSync(debugPath)) {
    return [];
  }

  return readFileSync(debugPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const tests: IssueTest[] = [
  {
    name: "Allow Once is one-shot and does not become the next default",
    kind: "regression",
    scenario: "An ordinary one-shot approval must not silently persist for a later identical request.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const first = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-allow-once-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Once" },
        );
        assert.deepEqual(first, {});

        const second = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-allow-once-second",
          input: { command: "git status --short" },
        });

        assert.equal(second.block, true);
        assert.match(String(second.reason), /requires approval, but no interactive UI is available/i);
        assert.equal(harness.prompts.length, 1);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "plain Reject does not persist as a future default deny",
    kind: "regression",
    scenario: "A plain reject should deny only the current request; the same request can be prompted and approved later.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const rejected = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-reject-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Reject" },
        );
        assert.equal(rejected.block, true);
        assert.match(String(rejected.reason), /User denied bash command 'git status --short'\./);

        const approvedLater = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-reject-second",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Once" },
        );

        assert.deepEqual(approvedLater, {});
        assert.equal(harness.prompts.length, 2);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "Reject with Reason does not persist as a future default deny",
    kind: "regression",
    scenario: "Reject with Reason returns feedback for the current request but must not save a future matching denial.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const rejected = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-reject-reason-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Reject with Reason", inputResponse: "Use read-only inspection instead" },
        );
        assert.equal(rejected.block, true);
        assert.match(String(rejected.reason), /Reason: Use read-only inspection instead\./);

        const approvedLater = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-reject-reason-second",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Once" },
        );

        assert.deepEqual(approvedLater, {});
        assert.equal(harness.prompts.length, 2);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "Allow Always persists the explicitly matching request subject",
    kind: "regression",
    scenario: "An explicit Allow Always should approve a later identical command in the same session without prompting.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const first = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-always-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Always" },
        );
        assert.deepEqual(first, {});

        const second = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-always-second",
          input: { command: "git status --short" },
        });

        assert.deepEqual(second, {});
        assert.equal(harness.prompts.length, 1);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "Allow Always does not broaden to a different command subject",
    kind: "regression",
    scenario: "A saved Allow Always for one command must not become an implicit wildcard for unrelated bash commands.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const approved = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-always-scope-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Always" },
        );
        assert.deepEqual(approved, {});

        const differentCommand = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-always-scope-second",
          input: { command: "git log --oneline" },
        });

        assert.equal(differentCommand.block, true);
        assert.match(String(differentCommand.reason), /requires approval, but no interactive UI is available/i);
        assert.equal(harness.prompts.length, 1);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "configured deny overrides an existing Allow Always session approval",
    kind: "red",
    scenario: "After an explicit Allow Always exists, a later configured deny for the same subject must remain a hard boundary.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
      );
      const projectPolicyPath = join(harness.cwd, ".pi", "agent", "pi-permissions.jsonc");

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const first = await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-deny-overrides-first",
            input: { command: "git status --short" },
          },
          { hasUI: true, selectResponse: "Allow Always" },
        );
        assert.deepEqual(first, {});

        mkdirSync(join(harness.cwd, ".pi", "agent"), { recursive: true });
        writeFileSync(
          projectPolicyPath,
          `${JSON.stringify({ bash: { "git status --short": "deny" } }, null, 2)}\n`,
          "utf8",
        );
        await runLifecycle(harness, "resources_discover", { reason: "reload" });

        const denied = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-deny-overrides-second",
          input: { command: "git status --short" },
        });

        assert.equal(denied.block, true);
        assert.match(String(denied.reason), /not permitted to run 'bash' command 'git status --short'/);
        assert.match(String(denied.reason), /matched 'git status --short'/);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "YOLO auto-response does not save a session approval after it is disabled",
    kind: "red",
    scenario: "Explicit auto-response should approve while enabled but must not mutate the Allow Always/session approval store.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
        { extensionConfig: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true } },
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const autoApproved = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-yolo-first",
          input: { command: "git status --short" },
        });
        assert.deepEqual(autoApproved, {});
        assert.equal(harness.prompts.length, 0);

        writeFileSync(
          join(harness.baseDir, "extension-config.json"),
          `${JSON.stringify({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: false }, null, 2)}\n`,
          "utf8",
        );
        await runLifecycle(harness, "resources_discover", { reason: "reload" });

        const afterYoloDisabled = await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-yolo-second",
          input: { command: "git status --short" },
        });

        assert.equal(afterYoloDisabled.block, true);
        assert.match(String(afterYoloDisabled.reason), /requires approval, but no interactive UI is available/i);
      } finally {
        await harness.cleanup();
      }
    },
  },
  {
    name: "debug events distinguish once, always, reject, auto-response, and policy deny paths",
    kind: "red",
    scenario: "Permission review logs must expose enough resolution detail to audit repeated-decision states separately.",
    fn: async () => {
      const harness = createRuntimeHarness(
        { defaultPolicy: ASK_BASH_POLICY },
        ["bash"],
        { extensionConfig: { ...DEFAULT_EXTENSION_CONFIG, debug: true } },
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-audit-once",
            input: { command: "echo once" },
          },
          { hasUI: true, selectResponse: "Allow Once" },
        );
        await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-audit-always",
            input: { command: "echo always" },
          },
          { hasUI: true, selectResponse: "Allow Always" },
        );
        await runToolCall(
          harness,
          {
            toolName: "bash",
            toolCallId: "issue-26-audit-reject",
            input: { command: "echo reject" },
          },
          { hasUI: true, selectResponse: "Reject" },
        );

        writeFileSync(
          join(harness.baseDir, "extension-config.json"),
          `${JSON.stringify({ ...DEFAULT_EXTENSION_CONFIG, debug: true, yoloMode: true }, null, 2)}\n`,
          "utf8",
        );
        await runLifecycle(harness, "resources_discover", { reason: "reload" });
        await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-audit-auto",
          input: { command: "echo auto" },
        });

        mkdirSync(join(harness.cwd, ".pi", "agent"), { recursive: true });
        writeFileSync(
          join(harness.cwd, ".pi", "agent", "pi-permissions.jsonc"),
          `${JSON.stringify({ bash: { "echo deny": "deny" } }, null, 2)}\n`,
          "utf8",
        );
        writeFileSync(
          join(harness.baseDir, "extension-config.json"),
          `${JSON.stringify({ ...DEFAULT_EXTENSION_CONFIG, debug: true, yoloMode: false }, null, 2)}\n`,
          "utf8",
        );
        await runLifecycle(harness, "resources_discover", { reason: "reload" });
        await runToolCall(harness, {
          toolName: "bash",
          toolCallId: "issue-26-audit-deny",
          input: { command: "echo deny" },
        });

        const logEntries = readDebugLogLines(harness.debugPath);
        const approvedResolutions = logEntries
          .filter((entry) => entry.event === "permission_request.approved")
          .map((entry) => entry.resolution);
        const deniedResolutions = logEntries
          .filter((entry) => entry.event === "permission_request.denied")
          .map((entry) => entry.resolution);
        const autoEvents = logEntries.filter((entry) => entry.event === "permission_request.auto_approved");
        const policyDeniedEvents = logEntries.filter(
          (entry) => entry.event === "permission_request.blocked" && entry.resolution === "policy_denied",
        );
        const persistedApprovalEvents = logEntries.filter((entry) => entry.event === "permission_request.approval_persisted");
        const repeatedDecisionFields = ["decisionPersistence", "approvalPersistence", "decisionScope", "approvalScope"];

        assert.ok(approvedResolutions.includes("once"), "Allow Once approvals should log resolution 'once'");
        assert.ok(approvedResolutions.includes("always"), "Allow Always approvals should log resolution 'always'");
        assert.ok(deniedResolutions.includes("reject"), "Plain rejects should log resolution 'reject'");
        assert.ok(
          autoEvents.some((entry) => entry.toolCallId === "issue-26-audit-auto"),
          "Auto-response approvals should log a distinct auto_approved event",
        );
        assert.ok(
          policyDeniedEvents.some((entry) => entry.toolCallId === "issue-26-audit-deny"),
          "Configured denies should log a distinct policy_denied event",
        );
        assert.ok(
          persistedApprovalEvents.some((entry) => entry.toolCallId === "issue-26-audit-always"),
          "Allow Always should emit an auditable persistence event",
        );
        assert.ok(
          logEntries.some((entry) => repeatedDecisionFields.some((field) => Object.hasOwn(entry, field))),
          "Audit logs should explicitly identify repeated-decision persistence/scope metadata",
        );
      } finally {
        await harness.cleanup();
      }
    },
  },
];

async function runIssueTests(issueTests: readonly IssueTest[]): Promise<void> {
  const results: TestResult[] = [];

  for (const test of issueTests) {
    try {
      await test.fn();
      results.push({ name: test.name, kind: test.kind, status: "PASS" });
      console.log(`[PASS] ISSUE26-${test.kind.toUpperCase()}: ${test.name}`);
    } catch (error) {
      results.push({ name: test.name, kind: test.kind, status: "FAIL", error });
      console.error(`[FAIL] ISSUE26-${test.kind.toUpperCase()}: ${test.name}`);
      console.error(`  Scenario: ${test.scenario}`);
      console.error(`  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }

  const regressionFailures = results.filter((result) => result.kind === "regression" && result.status === "FAIL");
  const redFailures = results.filter((result) => result.kind === "red" && result.status === "FAIL");
  const redAlreadyPassing = results.filter((result) => result.kind === "red" && result.status === "PASS");

  console.log(
    `ISSUE26 summary: ${results.filter((result) => result.status === "PASS").length} passing regression/already-supported checks, `
    + `${redFailures.length} expected RED failures, ${regressionFailures.length} unexpected regression failures.`,
  );

  if (redAlreadyPassing.length > 0) {
    console.log(`ISSUE26 already implemented or partially implemented checks: ${redAlreadyPassing.map((result) => result.name).join("; ")}`);
  }

  if (regressionFailures.length > 0) {
    throw new Error(`Unexpected Issue #26 regression guard failures: ${regressionFailures.map((result) => result.name).join("; ")}`);
  }

  if (redFailures.length > 0) {
    throw new Error(`Expected Issue #26 RED failures before implementation: ${redFailures.map((result) => result.name).join("; ")}`);
  }
}

await runIssueTests(tests);
console.log("All Issue #26 repeated-resolution tests passed.");
