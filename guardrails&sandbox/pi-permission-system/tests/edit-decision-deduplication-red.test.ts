import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
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
import { runAsyncTest } from "./test-harness.js";

// Issue #29 RED coverage: the same edit request can be emitted twice in a row.
// Desired behavior: an "Allow Once" decision is reused for the same request id,
// while a new request id for identical edit content still requires its own approval.
// Not covered here: malformed edit payload validation, because this regression is
// about duplicate permission prompts for valid edit tool calls.

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type ToolCallHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  selectResponses: string[];
  cleanup: () => Promise<void>;
};

type ContextOptions = {
  hasUI?: boolean;
  selectResponse?: string;
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

function createAskAllPolicyConfig(): Record<string, unknown> {
  return {
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
  };
}

function createEditEvent(toolCallId: string): Record<string, unknown> {
  return {
    toolName: "edit",
    toolCallId,
    input: {
      path: "src/repeated-edit.ts",
      oldText: "export const answer = 41;\n",
      newText: "export const answer = 42;\n",
    },
  };
}

function createMockContext(
  harness: ToolCallHarness,
  options: ContextOptions = {},
): Record<string, unknown> {
  return {
    cwd: harness.cwd,
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "issue-29-session",
      getSessionDir: (): string => harness.cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        harness.prompts.push(title);
        return options.selectResponse ?? harness.selectResponses.shift() ?? "Allow Once";
      },
      input: async (): Promise<string | undefined> => undefined,
    },
  };
}

function createToolCallHarness(selectResponses: string[] = []): ToolCallHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-29-"));
  const cwd = join(baseDir, "workspace");
  const policyDir = join(baseDir, "policy");
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};

  const originalValues = new Map<string, string | undefined>();
  for (const key of [
    "PI_CODING_AGENT_DIR",
    PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
    CONFIG_PATH_ENV_KEY,
    LOGS_DIR_ENV_KEY,
    ...SUBAGENT_ENV_HINT_KEYS,
    SUBAGENT_PARENT_SESSION_ENV_KEY,
  ] as const) {
    originalValues.set(key, process.env[key]);
  }

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(policyDir, "agents"), { recursive: true });
  writeFileSync(
    join(policyDir, "pi-permissions.jsonc"),
    `${JSON.stringify(createAskAllPolicyConfig(), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = policyDir;
  process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY] = policyDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  for (const key of [...SUBAGENT_ENV_HINT_KEYS, SUBAGENT_PARENT_SESSION_ENV_KEY] as const) {
    delete process.env[key];
  }

  const harness: ToolCallHarness = {
    baseDir,
    cwd,
    prompts,
    handlers,
    selectResponses: [...selectResponses],
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(harness)));
      for (const [key, value] of originalValues.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => [{ name: "edit" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return harness;
}

async function runSessionStart(harness: ToolCallHarness): Promise<void> {
  const handler = harness.handlers.session_start;
  assert.equal(typeof handler, "function", "session_start handler should be registered");
  await Promise.resolve(handler({ reason: "startup" }, createMockContext(harness)));
}

async function runToolCall(
  harness: ToolCallHarness,
  event: Record<string, unknown>,
  options: ContextOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function", "tool_call handler should be registered");
  const result = await Promise.resolve(handler(event, createMockContext(harness, options)));
  return (result ?? {}) as Record<string, unknown>;
}

await runAsyncTest("ISSUE29: duplicate edit tool_call with the same request id reuses the Allow Once decision", async () => {
  const harness = createToolCallHarness(["Allow Once", "Reject"]);

  try {
    await runSessionStart(harness);

    const editEvent = createEditEvent("issue-29-same-edit-request");
    const first = await runToolCall(harness, editEvent);
    assert.deepEqual(first, {});

    const duplicate = await runToolCall(harness, editEvent);

    assert.deepEqual(
      duplicate,
      {},
      "a duplicate event for the same approved edit request should not ask again or allow the second UI answer to change the result",
    );
    assert.equal(
      harness.prompts.length,
      1,
      "the same edit request id should render exactly one permission prompt",
    );
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("ISSUE29: identical edit content with a new request id remains a separate approval", async () => {
  const harness = createToolCallHarness(["Allow Once"]);

  try {
    await runSessionStart(harness);

    const first = await runToolCall(harness, createEditEvent("issue-29-first-edit-request"));
    assert.deepEqual(first, {});

    const nextRequest = await runToolCall(
      harness,
      createEditEvent("issue-29-second-edit-request"),
      { hasUI: false },
    );

    assert.equal(nextRequest.block, true);
    assert.match(String(nextRequest.reason), /requires approval, but no interactive UI is available/i);
    assert.equal(
      harness.prompts.length,
      1,
      "Allow Once must not persist by file path or edit content for a later request id",
    );
  } finally {
    await harness.cleanup();
  }
});

console.log("Issue #29 repeated edit prompt TDD tests completed.");
