import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizePathForComparison } from "../src/common.js";
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
import { PermissionManager } from "../src/permission-manager.js";
import type { GlobalPermissionConfig, PermissionDefaultPolicy } from "../src/types.js";

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

const ASK_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

const ALLOW_TOOLS_POLICY: PermissionDefaultPolicy = {
  tools: "allow",
  bash: "allow",
  mcp: "allow",
  skills: "allow",
  special: "ask",
};

function resourcePath(pathValue: string, cwd: string): string {
  return normalizePathForComparison(pathValue, cwd).replaceAll("\\", "/").replace(/\/+$/u, "");
}

function directoryResourcePattern(directory: string, cwd: string): string {
  return `${resourcePath(directory, cwd)}/*`;
}

function externalDirectoryRule(directory: string, cwd: string): string {
  return `external_directory:${directoryResourcePattern(directory, cwd)}`;
}

function toolPathRule(toolName: string, directory: string, cwd: string): string {
  return `${toolName}:${directoryResourcePattern(directory, cwd)}`;
}

function createManager(config: GlobalPermissionConfig): { manager: PermissionManager; cleanup: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue25-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    manager: new PermissionManager({ globalConfigPath, agentsDir }),
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type RuntimeHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
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

function createMockContext(
  cwd: string,
  prompts: string[],
  options: RuntimeHarnessOptions = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    sessionManager: {
      getEntries: (): unknown[] => options.activeAgentName === undefined
        ? []
        : [{ type: "custom", customType: "active_agent", data: { name: options.activeAgentName } }],
      getSessionId: (): string => "issue-25-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return options.selectResponse ?? "Allow Once";
      },
      input: async (): Promise<string | undefined> => options.inputResponse,
    },
  };
}

function createRuntimeHarness(
  config: GlobalPermissionConfig,
  toolNames: readonly string[],
  options: RuntimeHarnessOptions = {},
): RuntimeHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue25-runtime-"));
  const cwd = options.cwd ?? join(baseDir, "workspace");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
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
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, options)));
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
  await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, options)));
}

async function runToolCall(
  harness: RuntimeHarness,
  event: Record<string, unknown>,
  options: RuntimeHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");
  const result = await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, options)));
  return (result ?? {}) as Record<string, unknown>;
}

const tests: IssueTest[] = [
  {
    name: "external_directory allows a canonical descendant resource pattern",
    kind: "red",
    scenario: "Configured external_directory:<canonical-dir>/* should allow a matching requested path without falling back to the literal external_directory key.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const allowedDir = "C:/Allowed";
      const allowedRule = externalDirectoryRule(allowedDir, cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        special: {
          external_directory: "ask",
          [allowedRule]: "allow",
        },
      });

      try {
        const result = manager.checkPermission("external_directory", {
          path: "c:/allowed/sub/file.txt",
          cwd,
        });

        assert.equal(result.state, "allow");
        assert.equal(result.matchedPattern, allowedRule);
        assert.equal(result.source, "special");
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "external_directory uses later matching deny over broad allow",
    kind: "red",
    scenario: "A later external_directory:<dir>/secrets/* deny must win over an earlier external_directory:<dir>/* allow for the same canonical path resource.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const allowedRule = externalDirectoryRule("C:/allowed", cwd);
      const secretDenyRule = externalDirectoryRule("C:/allowed/secrets", cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        special: {
          external_directory: "ask",
          [allowedRule]: "allow",
          [secretDenyRule]: "deny",
        },
      });

      try {
        const result = manager.checkPermission("external_directory", {
          path: "C:/allowed/secrets/token.txt",
          cwd,
        });

        assert.equal(result.state, "deny");
        assert.equal(result.matchedPattern, secretDenyRule);
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "external_directory traversal does not stay inside an allowed directory",
    kind: "regression",
    scenario: "A path containing .. must be canonicalized before matching so C:/allowed/../denied/file.txt does not match C:/allowed/*.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const allowedRule = externalDirectoryRule("C:/allowed", cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        special: {
          external_directory: "ask",
          [allowedRule]: "allow",
        },
      });

      try {
        const result = manager.checkPermission("external_directory", {
          path: "C:/allowed/../denied/file.txt",
          cwd,
        });

        assert.equal(result.state, "ask");
        assert.notEqual(result.state, "allow");
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "external_directory prefix collision does not match a sibling directory",
    kind: "regression",
    scenario: "C:/safe/* must not match C:/safe-evil/file.txt even though the string prefix is similar.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const safeRule = externalDirectoryRule("C:/safe", cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        special: {
          external_directory: "ask",
          [safeRule]: "allow",
        },
      });

      try {
        const result = manager.checkPermission("external_directory", {
          path: "C:/safe-evil/file.txt",
          cwd,
        });

        assert.equal(result.state, "ask");
        assert.notEqual(result.state, "allow");
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "path-bearing read action can be allowed for one in-worktree directory",
    kind: "red",
    scenario: "A read:<canonical-dir>/* tool resource rule should allow read under generated output without granting all read calls.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const generatedReadRule = toolPathRule("read", "C:/workspace/project/src/generated", cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        tools: {
          [generatedReadRule]: "allow",
        },
      });

      try {
        const result = manager.checkPermission("read", {
          path: "C:/workspace/project/src/generated/output.ts",
          cwd,
        });

        assert.equal(result.state, "allow");
        assert.equal(result.matchedPattern, generatedReadRule);
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "path-bearing read allow does not grant edit for the same path",
    kind: "regression",
    scenario: "Action/resource scoping must keep read:<dir>/* from authorizing edit:<dir>/* or all filesystem tools.",
    fn: () => {
      const cwd = "C:/workspace/project";
      const generatedReadRule = toolPathRule("read", "C:/workspace/project/src/generated", cwd);
      const { manager, cleanup } = createManager({
        defaultPolicy: ASK_POLICY,
        tools: {
          [generatedReadRule]: "allow",
        },
      });

      try {
        const result = manager.checkPermission("edit", {
          path: "C:/workspace/project/src/generated/output.ts",
          cwd,
        });

        assert.equal(result.state, "ask");
        assert.notEqual(result.state, "allow");
      } finally {
        cleanup();
      }
    },
  },
  {
    name: "runtime tool_call passes the external path resource into external_directory policy",
    kind: "red",
    scenario: "A tool_call targeting an allowed external sibling directory should skip the external_directory prompt and fall through to normal allowed tool policy.",
    fn: async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue25-paths-"));
      const cwd = join(baseDir, "workspace");
      const externalDir = join(baseDir, "allowed-external");
      const externalPath = join(externalDir, "child.txt");
      const allowedRule = externalDirectoryRule(externalDir, cwd);

      mkdirSync(cwd, { recursive: true });
      mkdirSync(externalDir, { recursive: true });

      const harness = createRuntimeHarness(
        {
          defaultPolicy: ALLOW_TOOLS_POLICY,
          special: {
            external_directory: "ask",
            [allowedRule]: "allow",
          },
        },
        ["read"],
        { cwd },
      );

      try {
        await runLifecycle(harness, "session_start", { reason: "startup" });
        const result = await runToolCall(harness, {
          toolName: "read",
          toolCallId: "issue-25-runtime-external-allow",
          input: { path: externalPath },
        });

        assert.deepEqual(result, {});
        assert.deepEqual(harness.prompts, []);
      } finally {
        await harness.cleanup();
        rmSync(baseDir, { recursive: true, force: true });
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
      console.log(`[PASS] ISSUE25-${test.kind.toUpperCase()}: ${test.name}`);
    } catch (error) {
      results.push({ name: test.name, kind: test.kind, status: "FAIL", error });
      console.error(`[FAIL] ISSUE25-${test.kind.toUpperCase()}: ${test.name}`);
      console.error(`  Scenario: ${test.scenario}`);
      console.error(`  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }

  const regressionFailures = results.filter((result) => result.kind === "regression" && result.status === "FAIL");
  const redFailures = results.filter((result) => result.kind === "red" && result.status === "FAIL");
  const redAlreadyPassing = results.filter((result) => result.kind === "red" && result.status === "PASS");

  console.log(
    `ISSUE25 summary: ${results.filter((result) => result.status === "PASS").length} passing regression/already-supported checks, `
    + `${redFailures.length} expected RED failures, ${regressionFailures.length} unexpected regression failures.`,
  );

  if (redAlreadyPassing.length > 0) {
    console.log(`ISSUE25 already implemented or partially implemented checks: ${redAlreadyPassing.map((result) => result.name).join("; ")}`);
  }

  if (regressionFailures.length > 0) {
    throw new Error(`Unexpected Issue #25 regression guard failures: ${regressionFailures.map((result) => result.name).join("; ")}`);
  }

  if (redFailures.length > 0) {
    throw new Error(`Expected Issue #25 RED failures before implementation: ${redFailures.map((result) => result.name).join("; ")}`);
  }
}

await runIssueTests(tests);
console.log("All Issue #25 directory/resource tests passed.");
