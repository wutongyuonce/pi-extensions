import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openPermissionSystemSettingsModal,
  registerPermissionSystemCommand,
} from "../src/config-modal.js";
import type { PermissionSystemExtensionConfig } from "../src/extension-config.js";

// RED coverage for Issue #27:
//   Extension "command:permission-system" error:
//   "Theme not initialized. Call initTheme() first."
//
// These tests intentionally do NOT call initTheme(). The command/modal already
// receives a renderer-local TUI theme from ctx.ui.custom(), so opening the
// settings UI should not depend on the pi-coding-agent global theme singleton.

type Notification = { message: string; level: "info" | "warning" | "error" };

type CustomRendererComponent = {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
};

type RegisteredCommandDefinition = {
  description: string;
  handler: (args: string, ctx: CommandContextStub) => Promise<void> | void;
};

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(renderer: (...args: unknown[]) => CustomRendererComponent, options?: unknown): Promise<T>;
  };
};

type RendererHarness = {
  ctx: CommandContextStub;
  notifications: Notification[];
  getCustomCalls(): number;
  getRenderCalls(): number;
  getDoneCalls(): number;
};

const THEME_SYMBOLS = [
  Symbol.for("@earendil-works/pi-coding-agent:theme"),
  Symbol.for("@mariozechner/pi-coding-agent:theme"),
] as const;

function clearGlobalPiThemes(): void {
  const globals = globalThis as Record<PropertyKey, unknown>;
  for (const symbol of THEME_SYMBOLS) {
    delete globals[symbol];
  }
}

function createRendererLocalTheme(): Record<string, unknown> {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: (_color: string) => "\x1b[38;5;255m",
    getBgAnsi: (_color: string) => "\x1b[48;5;16m",
  };
}

function createRendererHarness(): RendererHarness {
  const notifications: Notification[] = [];
  let customCalls = 0;
  let renderCalls = 0;
  let doneCalls = 0;

  return {
    ctx: {
      hasUI: true,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(renderer: (...args: unknown[]) => CustomRendererComponent, options?: unknown): Promise<T> {
          customCalls += 1;
          assert.deepEqual(options, {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: 82,
              maxHeight: "85%",
              margin: 1,
            },
          });

          const component = renderer(
            { requestRender: () => undefined },
            createRendererLocalTheme(),
            {},
            () => {
              doneCalls += 1;
            },
          );

          renderCalls += 1;
          const rendered = component.render(100);
          assert.ok(Array.isArray(rendered), "custom renderer must return renderable modal lines");
          assert.ok(rendered.length > 0, "custom renderer should render visible modal content");
          assert.ok(
            !rendered.join("\n").includes("Theme not initialized"),
            "settings modal must not render a Theme-not-initialized error when a renderer theme is provided",
          );
          component.invalidate();

          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
    getRenderCalls: () => renderCalls,
    getDoneCalls: () => doneCalls,
  };
}

function createConfig(): PermissionSystemExtensionConfig {
  return {
    debug: false,
    yoloMode: false,
    forwardedPromptTimeoutSeconds: 30,
  };
}

function createController(configPath: string): {
  getConfig(): PermissionSystemExtensionConfig;
  setConfig(next: PermissionSystemExtensionConfig): void;
  getConfigPath(): string;
} {
  let config = createConfig();

  return {
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    getConfigPath: () => configPath,
  };
}

function getRegisteredDefinition(definition: RegisteredCommandDefinition | null): RegisteredCommandDefinition {
  assert.ok(definition !== null, "permission-system command should be registered");
  return definition;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  }
  return String(error);
}

async function assertNoThemeInitializationFailure(
  scenario: string,
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert.fail(
      `${scenario} should open with the renderer-provided theme and without global initTheme(), but failed with:\n${formatError(error)}`,
    );
  }
}

type RedTestFailure = { name: string; error: unknown };
const redFailures: RedTestFailure[] = [];
let redTestCount = 0;

async function runIssue27RedTest(name: string, testFn: () => Promise<void>): Promise<void> {
  redTestCount += 1;
  try {
    clearGlobalPiThemes();
    await testFn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    redFailures.push({ name, error });
    console.error(`[FAIL] ${name}`);
    console.error(formatError(error));
  } finally {
    clearGlobalPiThemes();
  }
}

console.log("[INFO] Issue #27 subject modules imported successfully.");

await runIssue27RedTest("ISSUE27-RED-1: direct settings modal opens without requiring global initTheme", async () => {
  const harness = createRendererHarness();

  await assertNoThemeInitializationFailure("Direct openPermissionSystemSettingsModal invocation", async () => {
    await openPermissionSystemSettingsModal(
      harness.ctx as never,
      createController("C:/tmp/pi-permission-system/issue-27-direct-config.json"),
    );
  });

  assert.equal(harness.getCustomCalls(), 1, "direct modal path should invoke ctx.ui.custom exactly once");
  assert.equal(harness.getRenderCalls(), 1, "direct modal path should render the returned custom component");
  assert.equal(harness.notifications.length, 0, "interactive modal path should not notify an error");
});

await runIssue27RedTest("ISSUE27-RED-2: exported permission-system command handler opens the modal without requiring global initTheme", async () => {
  let definition: RegisteredCommandDefinition | null = null;
  registerPermissionSystemCommand(
    {
      registerCommand(name: string, nextDefinition: RegisteredCommandDefinition) {
        assert.equal(name, "permission-system");
        definition = nextDefinition;
      },
    } as never,
    createController("C:/tmp/pi-permission-system/issue-27-registered-config.json") as never,
  );

  const registeredDefinition = getRegisteredDefinition(definition);
  const harness = createRendererHarness();

  await assertNoThemeInitializationFailure("registerPermissionSystemCommand interactive handler", async () => {
    await registeredDefinition.handler("", harness.ctx);
  });

  assert.equal(harness.getCustomCalls(), 1, "registered command path should invoke ctx.ui.custom exactly once");
  assert.equal(harness.getRenderCalls(), 1, "registered command path should render the returned custom component");
  assert.equal(harness.notifications.length, 0, "interactive command path should not notify an error");
});

await runIssue27RedTest("ISSUE27-RED-3: interactive /permission-system invocations with legacy args still open without requiring global initTheme", async () => {
  let definition: RegisteredCommandDefinition | null = null;
  registerPermissionSystemCommand(
    {
      registerCommand(name: string, nextDefinition: RegisteredCommandDefinition) {
        assert.equal(name, "permission-system");
        definition = nextDefinition;
      },
    } as never,
    createController("C:/tmp/pi-permission-system/issue-27-legacy-args-config.json") as never,
  );

  const registeredDefinition = getRegisteredDefinition(definition);
  const harness = createRendererHarness();

  await assertNoThemeInitializationFailure("registerPermissionSystemCommand handler invoked with legacy args", async () => {
    await registeredDefinition.handler("show", harness.ctx);
  });

  assert.equal(harness.getCustomCalls(), 1, "legacy-arg command path should invoke ctx.ui.custom exactly once");
  assert.equal(harness.getRenderCalls(), 1, "legacy-arg command path should render the returned custom component");
  assert.equal(harness.notifications.length, 0, "legacy-arg command path should not notify an error");
});

await runIssue27RedTest("ISSUE27-RED-4: extension-registered /permission-system command opens without requiring global initTheme", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue27-red-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalConfigPath = process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH;
  const originalLogsDir = process.env.PI_PERMISSION_SYSTEM_LOGS_DIR;

  try {
    const configPath = join(baseDir, "extension-config.json");
    const logsDir = join(baseDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(createConfig(), null, 2)}\n`, "utf8");

    process.env.PI_CODING_AGENT_DIR = baseDir;
    process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH = configPath;
    process.env.PI_PERMISSION_SYSTEM_LOGS_DIR = logsDir;

    const { default: piPermissionSystemExtension } = await import("../src/index.js");
    let definition: RegisteredCommandDefinition | null = null;

    piPermissionSystemExtension({
      on: () => undefined,
      registerCommand(name: string, nextDefinition: RegisteredCommandDefinition) {
        if (name === "permission-system") {
          definition = nextDefinition;
        }
      },
      getAllTools: () => [],
      setActiveTools: () => undefined,
      registerProvider: () => undefined,
      events: {
        emit: () => undefined,
      },
    } as never);

    const registeredDefinition = getRegisteredDefinition(definition);
    const harness = createRendererHarness();

    await assertNoThemeInitializationFailure("extension default command:permission-system handler", async () => {
      await registeredDefinition.handler("", harness.ctx);
    });

    assert.equal(harness.getCustomCalls(), 1, "extension command path should invoke ctx.ui.custom exactly once");
    assert.equal(harness.getRenderCalls(), 1, "extension command path should render the returned custom component");
    assert.equal(harness.notifications.length, 0, "extension command path should not notify an error");
    assert.equal(harness.getDoneCalls(), 0, "opening the modal should not close it immediately");
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalConfigPath === undefined) {
      delete process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH;
    } else {
      process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH = originalConfigPath;
    }
    if (originalLogsDir === undefined) {
      delete process.env.PI_PERMISSION_SYSTEM_LOGS_DIR;
    } else {
      process.env.PI_PERMISSION_SYSTEM_LOGS_DIR = originalLogsDir;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

if (redFailures.length > 0) {
  console.error(`[RED] ${redFailures.length}/${redTestCount} Issue #27 tests failed before the production fix.`);
  for (const failure of redFailures) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    console.error(`[RED] ${failure.name}: ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`[GREEN] ${redTestCount}/${redTestCount} Issue #27 tests passed.`);
}
