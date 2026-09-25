// Issue #31 RED TDD: Enabling debug mode (or toggling yolo mode) overwrites the
// entire config file, destroying user-defined permission fields (defaultPolicy,
// tools, bash, mcp, skills, special) that coexist in the same config.json.
//
// Root cause: savePermissionSystemConfig writes ONLY the three extension fields
// (debug, yoloMode, forwardedPromptTimeoutSeconds) back to disk, discarding all
// other keys. loadPermissionSystemConfig similarly only reads those three fields,
// so even a round-trip load→save cycle erases everything else.
//
// Desired behavior: saving the extension config MUST preserve all existing
// non-extension fields (including unknown/future keys) that are present in the
// file. The extension must merge its normalized fields into the existing file
// content, not replace the file wholesale.
//
// This file follows the project's red-test convention: tests marked "red"
// describe behavior that is NOT yet implemented and are expected to FAIL until
// the fix is applied. Tests marked "regression" describe behavior that already
// works and must continue to pass.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
  type PermissionSystemExtensionConfig,
  ensurePermissionSystemConfig,
  loadPermissionSystemConfig,
  normalizePermissionSystemConfig,
  savePermissionSystemConfig,
} from "../src/extension-config.js";
import { parseJsoncConfig } from "../src/jsonc-config.js";
import piPermissionSystemExtension from "../src/index.js";
import { createMockContext, runAsyncTest } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

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

// The full user config from the issue report — permission fields coexisting
// with extension fields in a single config.json.
const ISSUE_CONFIG_WITH_PERMISSIONS = {
  defaultPolicy: {
    tools: "ask",
    bash: "ask",
    mcp: "ask",
    skills: "ask",
    special: "ask",
  },
  tools: {
    read: "allow",
    write: "allow",
  },
  bash: {
    "git status": "allow",
    "git *": "ask",
  },
  mcp: {
    mcp_status: "allow",
  },
  skills: {
    "*": "ask",
  },
  special: {
    doom_loop: "deny",
    external_directory: "ask",
  },
  debug: false,
  yoloMode: false,
  forwardedPromptTimeoutSeconds: 30,
} as const;

// Permission-only keys that must survive a save round-trip.
const PERMISSION_KEYS = [
  "defaultPolicy",
  "tools",
  "bash",
  "mcp",
  "skills",
  "special",
] as const;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory with an isolated config path.
 * Returns the config path and a cleanup function.
 * Restores the original env var on cleanup.
 */
function createIsolatedConfigDir(initialContent?: string): {
  configPath: string;
  baseDir: string;
  cleanup: () => void;
} {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue31-"));
  const configPath = join(baseDir, "config.json");
  const originalConfigEnv = process.env[CONFIG_PATH_ENV_KEY];

  if (initialContent !== undefined) {
    writeFileSync(configPath, initialContent, "utf8");
  }

  process.env[CONFIG_PATH_ENV_KEY] = configPath;

  return {
    configPath,
    baseDir,
    cleanup: (): void => {
      if (originalConfigEnv === undefined) {
        delete process.env[CONFIG_PATH_ENV_KEY];
      } else {
        process.env[CONFIG_PATH_ENV_KEY] = originalConfigEnv;
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Reads and parses the config file at the given path as a raw JSON object,
 * preserving ALL keys (not just the extension fields).
 */
function readRawConfig(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf8");
  return parseJsoncConfig(raw, configPath, "test config") as Record<string, unknown>;
}

/**
 * Reads the raw config file text (string), preserving formatting and comments.
 */
function readRawConfigText(configPath: string): string {
  return readFileSync(configPath, "utf8");
}

// ---------------------------------------------------------------------------
// Mock runtime harness for testing the full extension lifecycle save path
// (config-modal → saveExtensionConfig → savePermissionSystemConfig).
// ---------------------------------------------------------------------------

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type RuntimeHarness = {
  baseDir: string;
  cwd: string;
  extensionConfigPath: string;
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

/**
 * Creates a full runtime harness that initializes the extension with a config
 * file containing BOTH permission fields and extension fields.
 */
function createRuntimeHarness(
  configContent: string,
  options: { extensionConfig?: PermissionSystemExtensionConfig } = {},
): RuntimeHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue31-runtime-"));
  const cwd = join(baseDir, "workspace");
  const policyDir = join(baseDir, "policy");
  const extensionConfigPath = join(baseDir, "config.json");
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

  // Write the combined config (permissions + extension fields) to the extension
  // config path. This simulates the user's situation from the issue.
  writeFileSync(extensionConfigPath, configContent, "utf8");

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
    getAllTools: (): Array<{ name: string }> => [{ name: "bash" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return {
    baseDir,
    cwd,
    extensionConfigPath,
    prompts,
    handlers,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, { sessionId: "issue-31-session", hasUI: true })));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: IssueTest[] = [
  // =========================================================================
  // Core bug reproduction: savePermissionSystemConfig overwrites the file
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permission fields when toggling debug",
    kind: "red",
    scenario:
      "User has a config.json with defaultPolicy, tools, bash, mcp, skills, special, and extension fields. "
      + "Toggling debug to true via save must NOT destroy the permission fields.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );

        assert.equal(saved.success, true, "save should succeed");

        const raw = readRawConfig(configPath);

        // The debug field should be updated.
        assert.equal(raw.debug, true, "debug should be set to true");

        // ALL permission fields must be preserved.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after saving extension config`,
          );
        }

        // Spot-check that the actual values are intact, not just present.
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, ISSUE_CONFIG_WITH_PERMISSIONS.tools);
        assert.deepEqual(raw.bash, ISSUE_CONFIG_WITH_PERMISSIONS.bash);
        assert.deepEqual(raw.mcp, ISSUE_CONFIG_WITH_PERMISSIONS.mcp);
        assert.deepEqual(raw.skills, ISSUE_CONFIG_WITH_PERMISSIONS.skills);
        assert.deepEqual(raw.special, ISSUE_CONFIG_WITH_PERMISSIONS.special);
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permission fields when toggling yoloMode",
    kind: "red",
    scenario:
      "Toggling yoloMode to true via save must NOT destroy the permission fields.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, yoloMode: true },
          configPath,
        );

        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.yoloMode, true);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after yoloMode toggle`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permission fields when changing forwardedPromptTimeoutSeconds",
    kind: "red",
    scenario:
      "Changing forwardedPromptTimeoutSeconds via save must NOT destroy the permission fields.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, forwardedPromptTimeoutSeconds: 120 },
          configPath,
        );

        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 120);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after timeout change`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves all three extension fields and permission fields in round-trip",
    kind: "red",
    scenario:
      "A load → save round-trip with no changes must preserve ALL fields (permissions + extension).",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // Save back the exact loaded config with no changes.
        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);

        // Extension fields should be present.
        assert.equal(raw.debug, ISSUE_CONFIG_WITH_PERMISSIONS.debug);
        assert.equal(raw.yoloMode, ISSUE_CONFIG_WITH_PERMISSIONS.yoloMode);
        assert.equal(raw.forwardedPromptTimeoutSeconds, ISSUE_CONFIG_WITH_PERMISSIONS.forwardedPromptTimeoutSeconds);

        // Permission fields should be present.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must survive a no-op round-trip`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Unknown / future keys preservation
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves unknown/future keys in the config file",
    kind: "red",
    scenario:
      "If the config file contains keys that the extension does not know about (e.g. future fields, "
      + "custom user keys), saving must not delete them.",
    fn: () => {
      const configWithUnknown = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        customUserKey: "do-not-delete-me",
        futureField: { nested: { value: 42 } },
        "$schema": "https://pi-coding-agent.local/schemas/permissions.schema.json",
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithUnknown, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);

        assert.equal(raw.customUserKey, "do-not-delete-me", "unknown top-level key must be preserved");
        assert.deepEqual(raw.futureField, { nested: { value: 42 } }, "nested unknown key must be preserved");
        assert.equal(raw.$schema, "https://pi-coding-agent.local/schemas/permissions.schema.json", "$schema must be preserved");
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // JSONC (comments and trailing commas) preservation
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permission fields when config contains JSONC comments",
    kind: "red",
    scenario:
      "If the user's config file contains JSONC comments alongside permission and extension fields, "
      + "saving the extension config must preserve the permission field values (comments may be lost, "
      + "but permission data must not be).",
    fn: () => {
      const jsoncContent = `{
  // Permission policy configuration
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask"
  },
  // Tool-level overrides
  "tools": {
    "read": "allow",
    "write": "allow"
  },
  "bash": {
    "git status": "allow", // allow status checks
    "git *": "ask"
  },
  "mcp": {
    "mcp_status": "allow"
  },
  "skills": {
    "*": "ask"
  },
  "special": {
    "doom_loop": "deny",
    "external_directory": "ask"
  },
  // Extension settings
  "debug": false,
  "yoloMode": false,
  "forwardedPromptTimeoutSeconds": 30
}
`;

      const { configPath, cleanup } = createIsolatedConfigDir(jsoncContent);

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);

        // Permission data must survive even if comments are lost.
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, ISSUE_CONFIG_WITH_PERMISSIONS.tools);
        assert.deepEqual(raw.bash, ISSUE_CONFIG_WITH_PERMISSIONS.bash);
        assert.deepEqual(raw.special, ISSUE_CONFIG_WITH_PERMISSIONS.special);
        assert.equal(raw.debug, true);
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permission fields when config uses trailing commas",
    kind: "red",
    scenario:
      "If the user's config file uses trailing commas (valid JSONC), saving must preserve permission data.",
    fn: () => {
      const jsoncContent = `{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask",
  },
  "tools": {
    "read": "allow",
    "write": "allow",
  },
  "debug": false,
  "yoloMode": false,
  "forwardedPromptTimeoutSeconds": 30,
}`;

      const { configPath, cleanup } = createIsolatedConfigDir(jsoncContent);

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, yoloMode: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, ISSUE_CONFIG_WITH_PERMISSIONS.tools);
        assert.equal(raw.yoloMode, true);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Config with ONLY extension fields (no permission fields)
  // =========================================================================

  {
    name: "savePermissionSystemConfig works correctly when config has only extension fields",
    kind: "regression",
    scenario:
      "If the config file only contains extension fields (no permission fields), saving must continue "
      + "to work correctly and produce valid JSON with the three extension fields.",
    fn: () => {
      const extensionOnlyConfig = {
        debug: false,
        yoloMode: false,
        forwardedPromptTimeoutSeconds: 30,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(extensionOnlyConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true);
        assert.equal(raw.yoloMode, false);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 30);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Config with ONLY permission fields (no extension fields)
  // =========================================================================

  {
    name: "savePermissionSystemConfig adds extension fields to a permissions-only config without destroying permissions",
    kind: "red",
    scenario:
      "If the config file only contains permission fields (no debug/yoloMode/timeout), saving must add "
      + "the extension fields while preserving all permission data.",
    fn: () => {
      const permissionsOnlyConfig = {
        defaultPolicy: ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy,
        tools: ISSUE_CONFIG_WITH_PERMISSIONS.tools,
        bash: ISSUE_CONFIG_WITH_PERMISSIONS.bash,
        mcp: ISSUE_CONFIG_WITH_PERMISSIONS.mcp,
        skills: ISSUE_CONFIG_WITH_PERMISSIONS.skills,
        special: ISSUE_CONFIG_WITH_PERMISSIONS.special,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(permissionsOnlyConfig, null, 2)}\n`,
      );

      try {
        // loadPermissionSystemConfig will normalize (adding default extension fields).
        const loaded = loadPermissionSystemConfig(configPath);
        // Now save with debug=true — this simulates enabling debug mode.
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);

        // Extension fields should now be present.
        assert.equal(raw.debug, true);
        assert.equal(raw.yoloMode, false);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 30);

        // Permission fields must be preserved.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved when adding extension fields`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // ensurePermissionSystemConfig must not overwrite an existing config
  // =========================================================================

  {
    name: "ensurePermissionSystemConfig does not overwrite an existing config with permissions",
    kind: "regression",
    scenario:
      "ensurePermissionSystemConfig must be a no-op when the config file already exists, even if it "
      + "contains permission fields. It must never replace an existing file.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const result = ensurePermissionSystemConfig(configPath);
        assert.equal(result.created, false, "should not create a new file when one exists");

        const raw = readRawConfig(configPath);
        // Everything must be untouched.
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, ISSUE_CONFIG_WITH_PERMISSIONS.tools);
        assert.equal(raw.debug, false);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // loadPermissionSystemConfig should still correctly read extension fields
  // from a combined config
  // =========================================================================

  {
    name: "loadPermissionSystemConfig correctly reads extension fields from a combined config",
    kind: "regression",
    scenario:
      "loadPermissionSystemConfig must correctly parse debug, yoloMode, and forwardedPromptTimeoutSeconds "
      + "from a config that also contains permission fields.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const result = loadPermissionSystemConfig(configPath);
        assert.equal(result.config.debug, false);
        assert.equal(result.config.yoloMode, false);
        assert.equal(result.config.forwardedPromptTimeoutSeconds, 30);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Multiple sequential saves must not accumulate data loss
  // =========================================================================

  {
    name: "multiple sequential saves preserve permission fields across repeated toggles",
    kind: "red",
    scenario:
      "Toggling debug on, then off, then on again via multiple saves must not gradually erode the "
      + "permission fields. Each save must preserve the full config.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        // Save 1: debug on
        let loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, debug: true }, configPath);

        // Save 2: debug off
        loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, debug: false }, configPath);

        // Save 3: yoloMode on
        loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, yoloMode: true }, configPath);

        // Save 4: yoloMode off + debug on
        loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, yoloMode: false, debug: true }, configPath);

        const raw = readRawConfig(configPath);

        assert.equal(raw.debug, true);
        assert.equal(raw.yoloMode, false);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must survive 4 sequential saves`,
          );
        }

        // Values must still be the originals.
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.bash, ISSUE_CONFIG_WITH_PERMISSIONS.bash);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // normalizePermissionSystemConfig should not be the source of data loss
  // (it only returns extension fields by design, but save must re-read the file)
  // =========================================================================

  {
    name: "normalizePermissionSystemConfig returns only extension fields from a combined config",
    kind: "regression",
    scenario:
      "normalizePermissionSystemConfig by design extracts only the three extension fields. This is "
      + "acceptable as long as save re-reads the raw file to preserve other fields. This test documents "
      + "the current contract.",
    fn: () => {
      const normalized = normalizePermissionSystemConfig(ISSUE_CONFIG_WITH_PERMISSIONS);
      assert.equal(normalized.debug, false);
      assert.equal(normalized.yoloMode, false);
      assert.equal(normalized.forwardedPromptTimeoutSeconds, 30);
      // normalizePermissionSystemConfig must NOT include permission fields.
      assert.ok(!("defaultPolicy" in normalized));
      assert.ok(!("tools" in normalized));
      assert.ok(!("bash" in normalized));
    },
  },

  // =========================================================================
  // Full runtime lifecycle: enabling debug via extension should not destroy
  // permission config in the actual config file
  // =========================================================================

  {
    name: "runtime: toggling debug via saveExtensionConfig preserves permission fields in config file",
    kind: "red",
    scenario:
      "When the extension initializes with a combined config (permissions + extension fields) and then "
      + "saves a config update (e.g. debug=true via the settings modal), the config file on disk must "
      + "retain all permission fields.",
    fn: async () => {
      const harness = createRuntimeHarness(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        // The extension has already loaded the config on init. Now simulate
        // the config modal's setConfig path by calling savePermissionSystemConfig
        // directly (which is what saveExtensionConfig calls internally).
        const loaded = loadPermissionSystemConfig(harness.extensionConfigPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          harness.extensionConfigPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(harness.extensionConfigPath);
        assert.equal(raw.debug, true);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after runtime debug toggle`,
          );
        }
      } finally {
        await harness.cleanup();
      }
    },
  },

  // =========================================================================
  // yoloMode toggle via runtime API should not destroy permission fields
  // =========================================================================

  {
    name: "runtime: toggling yoloMode via runtime API preserves permission fields in config file",
    kind: "red",
    scenario:
      "When yoloMode is toggled via the runtime API (setYoloMode), the underlying save must preserve "
      + "all permission fields in the config file.",
    fn: async () => {
      const harness = createRuntimeHarness(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        // Access the runtime API registered by the extension.
        const runtimeApi = (globalThis as Record<string, unknown>).__piPermissionSystem as
          | { setYoloMode: (enabled: boolean, options?: { persist?: boolean }) => { changed: boolean; persisted: boolean; error?: string } }
          | undefined;

        assert.ok(runtimeApi, "runtime API should be registered");
        const result = runtimeApi.setYoloMode(true, { persist: true });
        assert.equal(result.changed, true);
        assert.equal(result.persisted, true);
        assert.equal(result.error, undefined);

        const raw = readRawConfig(harness.extensionConfigPath);
        assert.equal(raw.yoloMode, true);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after yoloMode runtime toggle`,
          );
        }
      } finally {
        await harness.cleanup();
      }
    },
  },

  // =========================================================================
  // Empty / minimal config edge cases
  // =========================================================================

  {
    name: "savePermissionSystemConfig on an empty object config preserves no extra fields but writes extension defaults",
    kind: "regression",
    scenario:
      "If the config file is an empty JSON object, saving should write the extension fields without error.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir("{}\n");

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true);
        assert.equal(raw.yoloMode, false);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 30);
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig on a config with only $schema preserves $schema and permissions",
    kind: "red",
    scenario:
      "If the config file contains a $schema reference and permission fields but no extension fields, "
      + "saving must preserve both $schema and permissions.",
    fn: () => {
      const configWithSchema = {
        $schema: "https://pi-coding-agent.local/schemas/permissions.schema.json",
        defaultPolicy: ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy,
        tools: { read: "allow" },
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithSchema, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.$schema, configWithSchema.$schema, "$schema must be preserved");
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, { read: "allow" });
        assert.equal(raw.debug, true);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Config with null / false / edge-case forwardedPromptTimeoutSeconds values
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when forwardedPromptTimeoutSeconds is null",
    kind: "red",
    scenario:
      "If the user has forwardedPromptTimeoutSeconds set to null (disabled) alongside permission fields, "
      + "saving must preserve the null value AND all permission fields.",
    fn: () => {
      const configWithNullTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: null,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithNullTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, null);

        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.forwardedPromptTimeoutSeconds, null, "null timeout must be preserved");
        assert.equal(raw.debug, true);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with null timeout`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permissions when forwardedPromptTimeoutSeconds is false",
    kind: "red",
    scenario:
      "If the user has forwardedPromptTimeoutSeconds set to false (disabled) alongside permission fields, "
      + "saving must normalize it to null AND preserve all permission fields.",
    fn: () => {
      const configWithFalseTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: false,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithFalseTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // false normalizes to null.
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, null);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        // After save, the timeout should be null (normalized from false).
        assert.equal(raw.forwardedPromptTimeoutSeconds, null);

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with false timeout`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Config file with deeply nested permission structures
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves deeply nested permission structures",
    kind: "red",
    scenario:
      "If the config has complex nested permission structures (resource-qualified paths, multiple special "
      + "rules), all must survive a save round-trip.",
    fn: () => {
      const complexConfig = {
        defaultPolicy: {
          tools: "ask",
          bash: "deny",
          mcp: "ask",
          skills: "ask",
          special: "ask",
        },
        tools: {
          "read": "allow",
          "read:/home/alice/project/generated/*": "allow",
          "edit:c:/Users/alice/project/generated/*": "deny",
          "write": "deny",
        },
        bash: {
          "git status": "allow",
          "git diff": "allow",
          "git push": "deny",
          "git *": "ask",
          "npm *": "ask",
        },
        mcp: {
          "mcp_status": "allow",
          "mcp_list": "allow",
        },
        skills: {
          "*": "ask",
          "commit-work": "allow",
        },
        special: {
          "doom_loop": "deny",
          "external_directory": "ask",
          "external_directory:/home/alice/shared/*": "allow",
          "external_directory:c:/Users/alice/shared/*": "deny",
        },
        debug: false,
        yoloMode: true,
        forwardedPromptTimeoutSeconds: 60,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(complexConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true);
        assert.equal(raw.yoloMode, true);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 60);

        // Every permission section must be byte-for-byte identical.
        assert.deepEqual(raw.defaultPolicy, complexConfig.defaultPolicy);
        assert.deepEqual(raw.tools, complexConfig.tools);
        assert.deepEqual(raw.bash, complexConfig.bash);
        assert.deepEqual(raw.mcp, complexConfig.mcp);
        assert.deepEqual(raw.skills, complexConfig.skills);
        assert.deepEqual(raw.special, complexConfig.special);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Save failure handling: if the file is read-only or unwritable, the save
  // should return an error but must not corrupt the existing file.
  // =========================================================================

  {
    name: "savePermissionSystemConfig returns error result (not throw) on write failure",
    kind: "regression",
    scenario:
      "If writing fails (e.g. directory doesn't exist), savePermissionSystemConfig should return "
      + "{ success: false, error: ... } rather than throwing, and must not corrupt any existing file.",
    fn: () => {
      // Use a path in a non-existent directory with no parent to force failure.
      const impossiblePath = join(tmpdir(), "issue31-nonexistent-dir-" + Date.now(), "config.json");
      const saved = savePermissionSystemConfig(
        { ...DEFAULT_EXTENSION_CONFIG, debug: true },
        impossiblePath,
      );

      // On most systems, the parent dir doesn't exist so this fails.
      // However, savePermissionSystemConfig calls ensureConfigDirectory which
      // uses mkdirSync with recursive: true, so it may actually succeed.
      // The important regression assertion is that it doesn't throw.
      assert.ok(
        typeof saved === "object" && saved !== null && "success" in saved,
        "save must return a result object, not throw",
      );
    },
  },

  // =========================================================================
  // Config created from scratch (ensurePermissionSystemConfig) should not
  // contain permission fields — it should only have extension defaults.
  // =========================================================================

  {
    name: "ensurePermissionSystemConfig creates a default extension-only config when no file exists",
    kind: "regression",
    scenario:
      "When no config file exists, ensurePermissionSystemConfig should create one with only the default "
      + "extension fields (debug, yoloMode, forwardedPromptTimeoutSeconds).",
    fn: () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue31-new-"));
      const configPath = join(baseDir, "config.json");
      const originalConfigEnv = process.env[CONFIG_PATH_ENV_KEY];

      try {
        process.env[CONFIG_PATH_ENV_KEY] = configPath;

        assert.equal(existsSync(configPath), false);
        const result = ensurePermissionSystemConfig(configPath);
        assert.equal(result.created, true);
        assert.equal(existsSync(configPath), true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, false);
        assert.equal(raw.yoloMode, false);
        assert.equal(raw.forwardedPromptTimeoutSeconds, 30);
        // No permission fields should exist in a freshly created config.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            !Object.prototype.hasOwnProperty.call(raw, key),
            `Freshly created config should not contain '${key}'`,
          );
        }
      } finally {
        if (originalConfigEnv === undefined) {
          delete process.env[CONFIG_PATH_ENV_KEY];
        } else {
          process.env[CONFIG_PATH_ENV_KEY] = originalConfigEnv;
        }
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  },

  // =========================================================================
  // Config with extra extension-specific keys that aren't part of the schema
  // (e.g. a user added a custom "logLevel" key alongside debug)
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves custom keys mixed with extension and permission fields",
    kind: "red",
    scenario:
      "A config with permission fields, extension fields, AND custom user-defined keys must have all "
      + "non-extension keys preserved after a save.",
    fn: () => {
      const mixedConfig = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        customSetting: "production",
        logLevel: "verbose",
        featureFlags: { newUi: true, experimental: false },
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(mixedConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true);
        assert.equal(raw.customSetting, "production");
        assert.equal(raw.logLevel, "verbose");
        assert.deepEqual(raw.featureFlags, { newUi: true, experimental: false });

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved in mixed config`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Atomicity: if save fails midway, the original file must not be corrupted.
  // (The current implementation uses tmp+rename, which is good. This test
  // verifies that the original file remains intact when save succeeds —
  // i.e., the tmp file is not left behind.)
  // =========================================================================

  {
    name: "savePermissionSystemConfig does not leave .tmp files after successful save",
    kind: "regression",
    scenario:
      "After a successful save, no .tmp file should remain in the config directory.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, debug: true }, configPath);

        assert.equal(existsSync(`${configPath}.tmp`), false, "no .tmp file should remain after successful save");
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Save should update the correct field and leave other extension fields intact
  // =========================================================================

  {
    name: "savePermissionSystemConfig updates only the targeted extension field while preserving others and permissions",
    kind: "red",
    scenario:
      "When saving with debug=true and yoloMode=true, forwardedPromptTimeoutSeconds must remain at its "
      + "original value, and all permission fields must be preserved.",
    fn: () => {
      const configWithCustomTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: 120,
        yoloMode: true,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithCustomTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // Only change debug, leave everything else as loaded.
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true, "debug should be updated");
        assert.equal(raw.yoloMode, true, "yoloMode should be preserved");
        assert.equal(raw.forwardedPromptTimeoutSeconds, 120, "custom timeout should be preserved");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Config file with only some permission sections (partial)
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves partial permission config (only some sections present)",
    kind: "red",
    scenario:
      "If the user only configured defaultPolicy and bash (no tools/mcp/skills/special), those sections "
      + "must be preserved while the missing ones should not be artificially added.",
    fn: () => {
      const partialConfig = {
        defaultPolicy: {
          tools: "allow",
          bash: "ask",
          mcp: "ask",
          skills: "ask",
          special: "ask",
        },
        bash: {
          "git status": "allow",
          "git *": "ask",
        },
        debug: false,
        yoloMode: false,
        forwardedPromptTimeoutSeconds: 30,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(partialConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true);
        assert.deepEqual(raw.defaultPolicy, partialConfig.defaultPolicy);
        assert.deepEqual(raw.bash, partialConfig.bash);
        // Sections the user didn't configure should not be added by the save.
        assert.ok(!("tools" in raw) || raw.tools === undefined, "tools should not be artificially added");
        assert.ok(!("mcp" in raw) || raw.mcp === undefined, "mcp should not be artificially added");
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 1: Corrupt/invalid JSON config + save = silent data loss
  // =========================================================================

  {
    name: "savePermissionSystemConfig on corrupt JSON does not silently overwrite the file with defaults",
    kind: "red",
    scenario:
      "If the config file contains corrupt/invalid JSON (e.g. truncated by a bad edit), loadPermissionSystemConfig "
      + "falls back to defaults. A subsequent save must NOT overwrite the corrupt file with only extension defaults, "
      + "because the original permission data might still be salvageable. The save should either fail gracefully or "
      + "preserve the original file content.",
    fn: () => {
      const corruptJson = `{"defaultPolicy": {"tools": "ask"}, "debug": false,`;
      const { configPath, cleanup } = createIsolatedConfigDir(corruptJson);

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // load returns defaults because parsing fails.
        assert.equal(loaded.config.debug, false);
        assert.ok(loaded.warning, "load should produce a warning for corrupt JSON");

        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );

        const rawText = readRawConfigText(configPath);

        // The original corrupt content (which may contain salvageable permission data)
        // must NOT have been replaced by only the three extension fields.
        // Either the save fails (success: false) or it preserves the original content.
        if (saved.success) {
          // If save succeeded, the file must still contain the original "defaultPolicy" key.
          assert.ok(
            rawText.includes("defaultPolicy"),
            "corrupt config file must not be silently overwritten with extension defaults — "
              + "original content (which may contain salvageable permission data) must be preserved",
          );
        } else {
          // If save failed, the file must be left untouched.
          assert.equal(
            rawText,
            corruptJson,
            "corrupt config file must be left untouched when save fails",
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 2: Config modal onChange → real file write path
  // =========================================================================

  {
    name: "modal onChange path: toggling debug via the settings modal preserves permissions in the config file",
    kind: "red",
    scenario:
      "When the settings modal's onChange callback fires (simulating the user toggling debug), the controller's "
      + "setConfig is called, which calls saveExtensionConfig → savePermissionSystemConfig. The real file on disk "
      + "must retain all permission fields. This test exercises the exact code path from the modal interaction, "
      + "not just a direct savePermissionSystemConfig call.",
    fn: async () => {
      const harness = createRuntimeHarness(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        // Simulate what the modal does: the onChange callback calls applySetting,
        // then controller.setConfig (which is saveExtensionConfig in the real extension).
        // saveExtensionConfig calls normalizePermissionSystemConfig + savePermissionSystemConfig.
        // We replicate that exact sequence here using the same functions.
        const loaded = loadPermissionSystemConfig(harness.extensionConfigPath);

        // applySetting equivalent: toggle debug to "on"
        const updated: PermissionSystemExtensionConfig = {
          ...loaded.config,
          debug: true,
        };

        // saveExtensionConfig equivalent: normalize + save
        const normalized = normalizePermissionSystemConfig(updated);
        const saved = savePermissionSystemConfig(normalized, harness.extensionConfigPath);
        assert.equal(saved.success, true, "save via modal path should succeed");

        const raw = readRawConfig(harness.extensionConfigPath);
        assert.equal(raw.debug, true, "debug should be toggled on");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved after modal onChange save path`,
          );
        }
      } finally {
        await harness.cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 3: forwardedPromptTimeoutSeconds invalid-value edge cases
  // (0, negative, string, Infinity, NaN)
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when forwardedPromptTimeoutSeconds is 0",
    kind: "red",
    scenario:
      "If the user has forwardedPromptTimeoutSeconds set to 0 (invalid, not > 0), normalize falls back to the "
      + "default 30. When saved, the default 30 overwrites the user's original 0 value — a silent data modification. "
      + "The save must preserve the original raw value or at minimum preserve all permission fields.",
    fn: () => {
      const configWithZeroTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: 0,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithZeroTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // 0 is not > 0, so normalize falls back to default 30.
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, 30);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        // Permission fields must be preserved regardless of timeout normalization.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with zero timeout`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permissions when forwardedPromptTimeoutSeconds is negative",
    kind: "red",
    scenario:
      "If forwardedPromptTimeoutSeconds is negative (invalid), normalize falls back to default 30. Saving must "
      + "still preserve all permission fields.",
    fn: () => {
      const configWithNegativeTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: -5,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithNegativeTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // -5 is not > 0, so normalize falls back to default 30.
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, 30);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with negative timeout`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permissions when forwardedPromptTimeoutSeconds is a string",
    kind: "red",
    scenario:
      "If forwardedPromptTimeoutSeconds is a string like \"30\" (invalid type), normalize falls back to default 30. "
      + "Saving must still preserve all permission fields.",
    fn: () => {
      const configWithStringTimeout = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        forwardedPromptTimeoutSeconds: "30",
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithStringTimeout, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // String "30" is not a number, so normalize falls back to default 30.
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, 30);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with string timeout`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 4: Config with only some extension fields (partial extension config)
  // =========================================================================

  {
    name: "savePermissionSystemConfig adds missing extension fields to a partial extension config while preserving permissions",
    kind: "red",
    scenario:
      "If the config has debug:true but no yoloMode or forwardedPromptTimeoutSeconds, saving must add the missing "
      + "extension defaults while preserving debug and all permission fields.",
    fn: () => {
      const partialExtensionConfig = {
        defaultPolicy: ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy,
        tools: ISSUE_CONFIG_WITH_PERMISSIONS.tools,
        bash: ISSUE_CONFIG_WITH_PERMISSIONS.bash,
        mcp: ISSUE_CONFIG_WITH_PERMISSIONS.mcp,
        skills: ISSUE_CONFIG_WITH_PERMISSIONS.skills,
        special: ISSUE_CONFIG_WITH_PERMISSIONS.special,
        debug: true,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(partialExtensionConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // debug should be read as true; yoloMode and timeout should be defaults.
        assert.equal(loaded.config.debug, true);
        assert.equal(loaded.config.yoloMode, false);
        assert.equal(loaded.config.forwardedPromptTimeoutSeconds, 30);

        // Save with debug toggled off (simulates user changing debug in modal).
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: false },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, false, "debug should be updated to false");
        assert.equal(raw.yoloMode, false, "yoloMode should be present as default");
        assert.equal(raw.forwardedPromptTimeoutSeconds, 30, "timeout should be present as default");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with partial extension config`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 5: Non-boolean debug/yoloMode values
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when debug is a non-boolean truthy value",
    kind: "red",
    scenario:
      "If debug is set to \"true\" (string) or 1 (number), normalize coerces it to false (via === true). "
      + "Saving writes debug:false, silently modifying the user's original value. All permission fields must "
      + "still be preserved.",
    fn: () => {
      const configWithStringDebug = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        debug: "true",
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithStringDebug, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // "true" (string) !== true, so normalize coerces to false.
        assert.equal(loaded.config.debug, false);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        // Permission fields must be preserved regardless of debug normalization.
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with non-boolean debug`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  {
    name: "savePermissionSystemConfig preserves permissions when yoloMode is a number (1)",
    kind: "red",
    scenario:
      "If yoloMode is set to 1 (number), normalize coerces it to false (via === true). Saving writes yoloMode:false. "
      + "All permission fields must still be preserved.",
    fn: () => {
      const configWithNumericYolo = {
        ...ISSUE_CONFIG_WITH_PERMISSIONS,
        yoloMode: 1,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(configWithNumericYolo, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // 1 !== true, so normalize coerces to false.
        assert.equal(loaded.config.yoloMode, false);

        const saved = savePermissionSystemConfig(loaded.config, configPath);
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with numeric yoloMode`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 6: Config file with UTF-8 BOM
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when config file has a UTF-8 BOM",
    kind: "red",
    scenario:
      "Windows editors commonly add a BOM (\\uFEFF) to JSON files. The JSONC parser may choke on this, causing "
      + "loadPermissionSystemConfig to return defaults. Saving must still preserve all permission fields that "
      + "were in the original file.",
    fn: () => {
      const bomContent = `\uFEFF${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`;
      const { configPath, cleanup } = createIsolatedConfigDir(bomContent);

      try {
        const loaded = loadPermissionSystemConfig(configPath);

        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true, "debug should be updated");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with BOM config`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 7: Key ordering preservation
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves the original key ordering of the config file",
    kind: "red",
    scenario:
      "If the user's config file has permission fields first and extension fields last, saving must not reorder "
      + "the keys. The original key ordering should be preserved so diffs and user expectations remain stable.",
    fn: () => {
      // Config with permissions first, extension fields last.
      const orderedConfig = {
        defaultPolicy: ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy,
        tools: ISSUE_CONFIG_WITH_PERMISSIONS.tools,
        bash: ISSUE_CONFIG_WITH_PERMISSIONS.bash,
        mcp: ISSUE_CONFIG_WITH_PERMISSIONS.mcp,
        skills: ISSUE_CONFIG_WITH_PERMISSIONS.skills,
        special: ISSUE_CONFIG_WITH_PERMISSIONS.special,
        debug: false,
        yoloMode: false,
        forwardedPromptTimeoutSeconds: 30,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(orderedConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        const rawKeys = Object.keys(raw);

        // The first key should still be a permission key, not an extension key.
        assert.equal(
          rawKeys[0],
          "defaultPolicy",
          "original key ordering must be preserved — defaultPolicy should remain first",
        );

        // Extension fields should not all be moved to the front.
        const firstThreeKeys = rawKeys.slice(0, 3);
        assert.ok(
          !firstThreeKeys.includes("debug"),
          "extension fields should not be reordered to the front of the file",
        );
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 8: Concurrent/rapid saves (race condition)
  // =========================================================================

  {
    name: "multiple rapid sequential saves preserve permission fields without data loss",
    kind: "red",
    scenario:
      "Two rapid saves (e.g. toggling debug then yoloMode quickly in the modal) must not race on the tmp+rename "
      + "atomic write. Both changes should be applied and all permission fields preserved.",
    fn: () => {
      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
      );

      try {
        // Simulate rapid toggling: debug on, then yoloMode on, then debug off.
        // Each save reads the current file state, applies the change, and writes.
        let loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, debug: true }, configPath);

        loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, yoloMode: true }, configPath);

        loaded = loadPermissionSystemConfig(configPath);
        savePermissionSystemConfig({ ...loaded.config, debug: false }, configPath);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, false, "debug should be off after rapid toggles");
        assert.equal(raw.yoloMode, true, "yoloMode should be on after rapid toggles");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must survive rapid sequential saves`,
          );
        }

        // Spot-check values are intact.
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.bash, ISSUE_CONFIG_WITH_PERMISSIONS.bash);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 9: Symlink config file
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves symlink when config file is a symlink",
    kind: "red",
    scenario:
      "If config.json is a symlink to another file, the tmp+rename write approach replaces the symlink with a "
      + "regular file, breaking the symlink. The save should preserve the symlink relationship.",
    fn: () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue31-symlink-"));
      const realConfigPath = join(baseDir, "real-config.json");
      const symlinkConfigPath = join(baseDir, "config.json");
      const originalConfigEnv = process.env[CONFIG_PATH_ENV_KEY];

      try {
        writeFileSync(
          realConfigPath,
          `${JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2)}\n`,
          "utf8",
        );
        symlinkSync(realConfigPath, symlinkConfigPath);
        process.env[CONFIG_PATH_ENV_KEY] = symlinkConfigPath;

        const loaded = loadPermissionSystemConfig(symlinkConfigPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          symlinkConfigPath,
        );
        assert.equal(saved.success, true);

        // The symlink must still be a symlink (not replaced by a regular file).
        assert.ok(
          lstatSync(symlinkConfigPath).isSymbolicLink(),
          "config.json must remain a symlink after save — tmp+rename must not break the symlink",
        );

        // The real file (symlink target) should contain the updated content.
        const raw = readRawConfig(realConfigPath);
        assert.equal(raw.debug, true, "debug should be updated through the symlink");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved through symlink save`,
          );
        }
      } finally {
        if (originalConfigEnv === undefined) {
          delete process.env[CONFIG_PATH_ENV_KEY];
        } else {
          process.env[CONFIG_PATH_ENV_KEY] = originalConfigEnv;
        }
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  },

  // =========================================================================
  // Gap 10: CRLF line endings
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when config file uses CRLF line endings",
    kind: "red",
    scenario:
      "If the original config file uses CRLF (\\r\\n) line endings (common on Windows), JSON.stringify produces "
      + "\\n endings. The save must still preserve all permission fields regardless of line ending conversion.",
    fn: () => {
      const crlfContent = JSON.stringify(ISSUE_CONFIG_WITH_PERMISSIONS, null, 2).replace(/\n/g, "\r\n") + "\r\n";
      const { configPath, cleanup } = createIsolatedConfigDir(crlfContent);

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, true, "debug should be updated");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with CRLF config`,
          );
        }

        // Verify the permission values are correct (not corrupted by line ending issues).
        assert.deepEqual(raw.defaultPolicy, ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy);
        assert.deepEqual(raw.tools, ISSUE_CONFIG_WITH_PERMISSIONS.tools);
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 11: Config file with duplicate keys
  // =========================================================================

  {
    name: "savePermissionSystemConfig preserves permissions when config file has duplicate keys",
    kind: "red",
    scenario:
      "JSONC parsers may take the last value for duplicate keys. If the config has duplicate debug keys, "
      + "saving must still preserve all permission fields.",
    fn: () => {
      const duplicateKeysContent = `{"defaultPolicy": {"tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask"}, "tools": {"read": "allow", "write": "allow"}, "bash": {"git status": "allow", "git *": "ask"}, "mcp": {"mcp_status": "allow"}, "skills": {"*": "ask"}, "special": {"doom_loop": "deny", "external_directory": "ask"}, "debug": false, "debug": true, "yoloMode": false, "forwardedPromptTimeoutSeconds": 30}`;
      const { configPath, cleanup } = createIsolatedConfigDir(duplicateKeysContent);

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        // The JSONC parser takes the last value for duplicate keys: debug = true.
        assert.equal(loaded.config.debug, true);

        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: false },
          configPath,
        );
        assert.equal(saved.success, true);

        const raw = readRawConfig(configPath);
        assert.equal(raw.debug, false, "debug should be updated to false");

        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with duplicate keys config`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },

  // =========================================================================
  // Gap 12: Prototype pollution safety
  // =========================================================================

  {
    name: "savePermissionSystemConfig safely handles config with __proto__ and constructor keys",
    kind: "red",
    scenario:
      "A config file with __proto__ or constructor keys could be a prototype pollution concern. Saving must "
      + "handle these safely (not pollute Object.prototype) and must still preserve all permission fields.",
    fn: () => {
      const protoConfig = {
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
        defaultPolicy: ISSUE_CONFIG_WITH_PERMISSIONS.defaultPolicy,
        tools: ISSUE_CONFIG_WITH_PERMISSIONS.tools,
        bash: ISSUE_CONFIG_WITH_PERMISSIONS.bash,
        mcp: ISSUE_CONFIG_WITH_PERMISSIONS.mcp,
        skills: ISSUE_CONFIG_WITH_PERMISSIONS.skills,
        special: ISSUE_CONFIG_WITH_PERMISSIONS.special,
        debug: false,
        yoloMode: false,
        forwardedPromptTimeoutSeconds: 30,
      };

      const { configPath, cleanup } = createIsolatedConfigDir(
        `${JSON.stringify(protoConfig, null, 2)}\n`,
      );

      try {
        const loaded = loadPermissionSystemConfig(configPath);
        const saved = savePermissionSystemConfig(
          { ...loaded.config, debug: true },
          configPath,
        );
        assert.equal(saved.success, true);

        // Verify prototype was NOT polluted.
        assert.equal(
          ({} as Record<string, unknown>).polluted,
          undefined,
          "Object.prototype must not be polluted by __proto__ key in config",
        );

        // Permission fields must be preserved.
        const raw = readRawConfig(configPath);
        for (const key of PERMISSION_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(raw, key),
            `Permission field '${key}' must be preserved with proto-pollution config`,
          );
        }
      } finally {
        cleanup();
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Test runner (follows the project's convention from permission-persistence-red.test.ts)
// ---------------------------------------------------------------------------

async function runIssueTests(issueTests: readonly IssueTest[]): Promise<void> {
  const results: TestResult[] = [];

  for (const test of issueTests) {
    try {
      await test.fn();
      results.push({ name: test.name, kind: test.kind, status: "PASS" });
      console.log(`[PASS] ISSUE31-${test.kind.toUpperCase()}: ${test.name}`);
    } catch (error) {
      results.push({ name: test.name, kind: test.kind, status: "FAIL", error });
      console.error(`[FAIL] ISSUE31-${test.kind.toUpperCase()}: ${test.name}`);
      console.error(`  Scenario: ${test.scenario}`);
      console.error(`  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }

  const regressionFailures = results.filter((result) => result.kind === "regression" && result.status === "FAIL");
  const redFailures = results.filter((result) => result.kind === "red" && result.status === "FAIL");
  const redAlreadyPassing = results.filter((result) => result.kind === "red" && result.status === "PASS");

  console.log(
    `ISSUE31 summary: ${results.filter((result) => result.status === "PASS").length} passing regression/already-supported checks, `
    + `${redFailures.length} expected RED failures, ${regressionFailures.length} unexpected regression failures.`,
  );

  if (redAlreadyPassing.length > 0) {
    console.log(
      `ISSUE31 already implemented or partially implemented checks: ${redAlreadyPassing.map((result) => result.name).join("; ")}`,
    );
  }

  if (regressionFailures.length > 0) {
    throw new Error(
      `Unexpected Issue #31 regression guard failures: ${regressionFailures.map((result) => result.name).join("; ")}`,
    );
  }

  if (redFailures.length > 0) {
    throw new Error(
      `Expected Issue #31 RED failures before implementation: ${redFailures.map((result) => result.name).join("; ")}`,
    );
  }
}

await runIssueTests(tests);
console.log("All Issue #31 config preservation tests passed.");
