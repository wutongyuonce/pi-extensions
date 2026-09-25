import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toRecord } from "./common.js";
import { formatJsoncConfigLoadWarning, isNodeErrorWithCode, parseJsoncConfig } from "./jsonc-config.js";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  /** Master switch. When false, the extension skips all registrations and startup work. */
  enabled?: boolean;
  debug: boolean;
  yoloMode: boolean;
  forwardedPromptTimeoutSeconds: number | null;
}

export interface PermissionSystemConfigLoadResult {
  config: PermissionSystemExtensionConfig;
  created: boolean;
  warning?: string;
}

export interface PermissionSystemConfigSaveResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  enabled: true,
  debug: false,
  yoloMode: false,
  forwardedPromptTimeoutSeconds: 30,
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const LOGS_DIR = join(EXTENSION_ROOT, "logs");
export const CONFIG_PATH_ENV_KEY = "PI_PERMISSION_SYSTEM_CONFIG_PATH";
export const LOGS_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_LOGS_DIR";

function resolveOverridablePath(explicitValue: string | undefined, envKey: string, defaultValue: string): string {
  const overridePath = process.env[envKey]?.trim();
  return explicitValue || overridePath || defaultValue;
}

export function getPermissionSystemConfigPath(configPath?: string): string {
  return resolveOverridablePath(configPath, CONFIG_PATH_ENV_KEY, CONFIG_PATH);
}

export function getPermissionSystemLogsDir(logsDir?: string): string {
  return resolveOverridablePath(logsDir, LOGS_DIR_ENV_KEY, LOGS_DIR);
}

export function getPermissionSystemDebugPath(logsDir = getPermissionSystemLogsDir()): string {
  return join(logsDir, `${EXTENSION_ID}-debug.jsonl`);
}

export function cloneDefaultConfig(): PermissionSystemExtensionConfig {
  return {
    enabled: DEFAULT_EXTENSION_CONFIG.enabled,
    debug: DEFAULT_EXTENSION_CONFIG.debug,
    yoloMode: DEFAULT_EXTENSION_CONFIG.yoloMode,
    forwardedPromptTimeoutSeconds: DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds,
  };
}

function createDefaultConfigContent(): string {
  return `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`;
}

export function normalizePermissionSystemConfig(raw: unknown): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  const rawTimeout = record.forwardedPromptTimeoutSeconds;
  let forwardedPromptTimeoutSeconds: number | null = DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds;

  if (rawTimeout === null || rawTimeout === false) {
    forwardedPromptTimeoutSeconds = null;
  } else if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
    forwardedPromptTimeoutSeconds = rawTimeout;
  }

  return {
    enabled: record.enabled !== false,
    debug: record.debug === true,
    yoloMode: record.yoloMode === true,
    forwardedPromptTimeoutSeconds,
  };
}

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

export function ensurePermissionSystemConfig(configPath = getPermissionSystemConfigPath()): { created: boolean; warning?: string } {
  if (existsSync(configPath)) {
    return { created: false };
  }

  try {
    ensureConfigDirectory(configPath);
    writeFileSync(configPath, createDefaultConfigContent(), "utf-8");
    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      created: false,
      warning: `Failed to initialize permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function loadPermissionSystemConfig(configPath = getPermissionSystemConfigPath()): PermissionSystemConfigLoadResult {
  const ensureResult = ensurePermissionSystemConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseJsoncConfig(raw, configPath, "permission-system config");
    const config = normalizePermissionSystemConfig(parsed);
    return {
      config,
      created: ensureResult.created,
      warning: ensureResult.warning,
    };
  } catch (error) {
    return {
      config: cloneDefaultConfig(),
      created: ensureResult.created,
      warning: ensureResult.warning
        ?? formatJsoncConfigLoadWarning(configPath, error, "permission-system config", "using default extension config")
        ?? undefined,
    };
  }
}

/**
 * Extension-managed keys that are written/updated by savePermissionSystemConfig.
 * All other keys in the config file are preserved as-is.
 */
const EXTENSION_CONFIG_KEYS: readonly (keyof PermissionSystemExtensionConfig)[] = [
  "debug",
  "yoloMode",
  "forwardedPromptTimeoutSeconds",
];

/**
 * Reads the existing config file and returns a parsed object plus a flag
 * indicating whether the file was readable and parseable.
 *
 * - Returns null when the file does not exist (caller should create fresh).
 * - Returns { parseError: true } when the file exists but cannot be parsed.
 *   The caller MUST NOT overwrite a corrupt file with only extension defaults.
 */
function readExistingConfig(
  configPath: string,
): { record: Record<string, unknown> | null; parseError: boolean } {
  if (!existsSync(configPath)) {
    return { record: null, parseError: false };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    // Strip a UTF-8 BOM if present so the JSONC parser can handle it.
    const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = parseJsoncConfig(bomStripped, configPath, "permission-system config");
    const record = toRecord(parsed);
    return { record, parseError: false };
  } catch {
    return { record: null, parseError: true };
  }
}

/**
 * Merges the normalized extension fields into the existing config record.
 *
 * - If an extension key already exists in the record, its value is updated in place
 *   (preserving key ordering).
 * - If an extension key does not exist, it is appended at the end.
 * - All non-extension keys (permissions, custom keys, $schema, etc.) are left untouched.
 * - Prototype-pollution keys (__proto__, constructor, prototype) are stripped.
 */
function mergeExtensionFields(
  existing: Record<string, unknown>,
  normalized: PermissionSystemExtensionConfig,
): Record<string, unknown> {
  // Build a safe copy that excludes prototype-pollution keys.
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(existing)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    merged[key] = existing[key];
  }

  const normalizedRecord: Record<string, unknown> = {
    debug: normalized.debug,
    yoloMode: normalized.yoloMode,
    forwardedPromptTimeoutSeconds: normalized.forwardedPromptTimeoutSeconds,
  };

  for (const key of EXTENSION_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      // Update in place — preserves original key ordering.
      merged[key] = normalizedRecord[key];
    } else {
      // Append at the end.
      merged[key] = normalizedRecord[key];
    }
  }

  return merged;
}

/**
 * Resolves the actual write target. If configPath is a symlink, returns the
 * realpath so that the symlink relationship is preserved (we write through to
 * the target instead of replacing the symlink with a regular file).
 */
function resolveWriteTarget(configPath: string): { writePath: string; isSymlink: boolean } {
  try {
    const stats = lstatSync(configPath);
    if (stats.isSymbolicLink()) {
      const realPath = realpathSync(configPath);
      return { writePath: realPath, isSymlink: true };
    }
  } catch (error) {
    // A missing file is expected (first write); any other lstat/realpath failure
    // falls through to writing configPath directly as a safe default.
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      return { writePath: configPath, isSymlink: false };
    }
  }
  return { writePath: configPath, isSymlink: false };
}

export function savePermissionSystemConfig(
  config: PermissionSystemExtensionConfig,
  configPath = getPermissionSystemConfigPath(),
): PermissionSystemConfigSaveResult {
  const normalized = normalizePermissionSystemConfig(config);

  // Read the existing file to preserve all non-extension keys.
  const existing = readExistingConfig(configPath);

  if (existing.parseError) {
    // The file exists but cannot be parsed. We MUST NOT overwrite it with
    // only the extension fields, as that would destroy potentially salvageable
    // permission data. Return a failure so the caller can inform the user.
    return {
      success: false,
      error: `Refusing to save permission-system config at '${configPath}': the existing file is corrupt or unparseable. Manual intervention is required to preserve existing permission data.`,
    };
  }

  // Merge extension fields into the existing record (or start fresh if no file).
  const baseRecord = existing.record ?? {};
  const merged = mergeExtensionFields(baseRecord, normalized);

  // Resolve the write target (handle symlinks by writing through to the real path).
  const { writePath } = resolveWriteTarget(configPath);
  const tmpPath = `${writePath}.tmp`;

  try {
    ensureConfigDirectory(writePath);
    writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, writePath);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch (cleanupError) {
      // Temp-file cleanup is best-effort; the OS will reclaim orphaned temp
      // files. Surface non-ENOENT failures so they are not silently lost.
      if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
        // Intentionally not propagated: the primary save error below is more
        // actionable to the caller than a leftover temp-file cleanup failure.
        void cleanupError;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to save permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function ensurePermissionSystemLogsDirectory(logsDir = getPermissionSystemLogsDir()): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
