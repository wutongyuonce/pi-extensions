import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piPermissionSystemExtension from "../src/index.js";
import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
} from "../src/extension-config.js";
import {
  requestPermissionDecisionFromUi,
  type PermissionDecisionUi,
} from "../src/permission-dialog.js";
import { createMockContext, runAsyncTest } from "./test-harness.js";

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type ToolCallHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  cleanup: () => Promise<void>;
};

const POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";
const SUBAGENT_ENV_KEYS = [
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT_ID",
  "PI_AGENT_ROUTER_AGENT_NAME",
  "PI_AGENT_ROUTER_DELEGATION_ID",
  "PI_AGENT_SUBAGENT_PARENT_SESSION_ID",
] as const;

const MAX_SAFE_EDIT_TOOL_CALL_PROMPT_LINES = 8;
const MAX_SAFE_EDIT_TOOL_CALL_PROMPT_CHARS = 1_000;
const MAX_SAFE_FALLBACK_PROMPT_LINES = 40;
const MAX_SAFE_FALLBACK_PROMPT_CHARS = 2_400;

function createPageSizedEditText(prefix: string, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_value, index) => `${prefix}-line-${String(index + 1).padStart(3, "0")}: ${"x".repeat(88)}`,
  ).join("\n");
}

function createToolCallHarness(): ToolCallHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-28-"));
  const cwd = join(baseDir, "repo");
  const policyDir = join(baseDir, "policy");
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};

  const originalValues = new Map<string, string | undefined>();
  for (const key of [
    "PI_CODING_AGENT_DIR",
    POLICY_AGENT_DIR_ENV_KEY,
    CONFIG_PATH_ENV_KEY,
    LOGS_DIR_ENV_KEY,
    ...SUBAGENT_ENV_KEYS,
  ]) {
    originalValues.set(key, process.env[key]);
  }

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(policyDir, "agents"), { recursive: true });
  writeFileSync(
    join(policyDir, "pi-permissions.jsonc"),
    `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = policyDir;
  process.env[POLICY_AGENT_DIR_ENV_KEY] = policyDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  for (const key of SUBAGENT_ENV_KEYS) {
    delete process.env[key];
  }

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

  return {
    baseDir,
    cwd,
    prompts,
    handlers,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, { sessionId: "issue-28-session", hasUI: true, selectResponse: "Reject" })));
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
}

async function runToolCall(
  harness: ToolCallHarness,
  event: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function", "tool_call handler should be registered");

  const result = await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, { sessionId: "issue-28-session", hasUI: true, selectResponse: "Reject" })));
  return (result ?? {}) as Record<string, unknown>;
}

await runAsyncTest("ISSUE28: edit tool_call permission prompt summarizes page-sized edit payloads", async () => {
  const harness = createToolCallHarness();

  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "test" }, createMockContext(harness.cwd, harness.prompts)));

    const oldText = createPageSizedEditText("old", 160);
    const newText = createPageSizedEditText("new", 160);
    const result = await runToolCall(harness, {
      toolName: "edit",
      toolCallId: "issue-28-large-edit",
      input: {
        path: "src/large-page.ts",
        oldText,
        newText,
      },
    });

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);

    const renderedTitle = harness.prompts[0] ?? "";
    const renderedLines = renderedTitle.split(/\r\n|\r|\n/);

    assert.ok(
      renderedLines.length <= MAX_SAFE_EDIT_TOOL_CALL_PROMPT_LINES,
      `permission select title must stay within a bounded page-safe line count; got ${renderedLines.length} lines`,
    );
    assert.ok(
      renderedTitle.length <= MAX_SAFE_EDIT_TOOL_CALL_PROMPT_CHARS,
      `permission select title must stay within a bounded page-safe character count; got ${renderedTitle.length} characters`,
    );
    assert.match(renderedTitle, /tool 'edit'/);
    assert.match(renderedTitle, /src\/large-page\.ts/);
    assert.match(renderedTitle, /replaces 160 lines with 160 lines/);
    assert.equal(
      renderedTitle.includes("old-line-160"),
      false,
      "permission prompt must not render the tail of a raw oldText payload",
    );
    assert.equal(
      renderedTitle.includes("new-line-160"),
      false,
      "permission prompt must not render the tail of a raw newText payload",
    );
    assert.equal(renderedTitle.includes("oldText:"), false);
    assert.equal(renderedTitle.includes("newText:"), false);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("ISSUE28: permission dialog compacts oversized fallback messages before select rendering", async () => {
  const captured: { title?: string } = {};
  const ui = {
    async select(title: string): Promise<string> {
      captured.title = title;
      return "Reject";
    },
    async input(): Promise<string | undefined> {
      return undefined;
    },
  } satisfies PermissionDecisionUi;

  const oldText = createPageSizedEditText("old", 160);
  const newText = createPageSizedEditText("new", 160);
  const oversizedFallbackMessage = [
    "Current agent requested tool 'custom_edit' with an oversized fallback payload.",
    "This simulates extension or forwarded permission messages that bypass the edit-specific formatter.",
    "",
    "oldText:",
    oldText,
    "",
    "newText:",
    newText,
    "",
    "Allow this call?",
  ].join("\n");

  const decision = await requestPermissionDecisionFromUi(
    ui,
    "Permission Required",
    oversizedFallbackMessage,
  );

  assert.equal(decision.approved, false);
  assert.equal(decision.state, "reject");

  const renderedTitle = captured.title ?? "";
  const renderedLines = renderedTitle.split(/\r\n|\r|\n/);

  assert.ok(
    renderedLines.length <= MAX_SAFE_FALLBACK_PROMPT_LINES,
    `permission select title must stay within a bounded page-safe line count; got ${renderedLines.length} lines`,
  );
  assert.ok(
    renderedTitle.length <= MAX_SAFE_FALLBACK_PROMPT_CHARS,
    `permission select title must stay within a bounded page-safe character count; got ${renderedTitle.length} characters`,
  );
  assert.equal(
    renderedTitle.includes("old-line-160"),
    false,
    "permission prompt must not render the tail of a raw oldText payload",
  );
  assert.equal(
    renderedTitle.includes("new-line-160"),
    false,
    "permission prompt must not render the tail of a raw newText payload",
  );
  assert.match(
    renderedTitle,
    /compacted|omitted|summarized|truncated/i,
    "permission prompt should tell the user that an oversized payload was compacted",
  );
});
