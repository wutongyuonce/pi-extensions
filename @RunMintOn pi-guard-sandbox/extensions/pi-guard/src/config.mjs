import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDefaultConfig, DEFAULT_DCG, GUARD_CONFIG_RELATIVE_PATH } from "./constants.mjs";

const ACTIONS = new Set(["allow", "notify", "confirm", "block"]);

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function withDefaults(value) {
  const defaults = createDefaultConfig();
  return {
    ...defaults,
    ...value,
    sandbox: { ...defaults.sandbox, ...(value.sandbox ?? {}) },
    dcg: { ...DEFAULT_DCG, ...(value.dcg ?? {}) },
    protectedPaths: { ...defaults.protectedPaths, ...(value.protectedPaths ?? {}) },
    bashPolicy: { ...defaults.bashPolicy, ...(value.bashPolicy ?? {}) },
  };
}

export function getGuardConfigPath(cwd) {
  return join(cwd, GUARD_CONFIG_RELATIVE_PATH);
}

export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function validateConfig(input) {
  const errors = [];
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  const value = raw ? withDefaults(raw) : null;
  if (!value) return { ok: false, error: "Config must be a JSON object." };

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push('"enabled" must be a boolean.');
  if (raw.sandbox !== undefined && (!raw.sandbox || typeof raw.sandbox !== "object" || Array.isArray(raw.sandbox))) errors.push('"sandbox" must be an object.');
  if (raw.dcg !== undefined && (!raw.dcg || typeof raw.dcg !== "object" || Array.isArray(raw.dcg))) errors.push('"dcg" must be an object.');
  if (raw.protectedPaths !== undefined && (!raw.protectedPaths || typeof raw.protectedPaths !== "object" || Array.isArray(raw.protectedPaths))) errors.push('"protectedPaths" must be an object.');
  if (raw.bashPolicy !== undefined && (!raw.bashPolicy || typeof raw.bashPolicy !== "object" || Array.isArray(raw.bashPolicy))) errors.push('"bashPolicy" must be an object.');
  if (typeof value.enabled !== "boolean") errors.push('"enabled" must be a boolean.');
  if (!value.sandbox || typeof value.sandbox.enabled !== "boolean") errors.push('"sandbox.enabled" must be a boolean.');
  if (value.mode !== "readonly" && value.mode !== "workspace-write") errors.push('"mode" must be "readonly" or "workspace-write".');
  if (value.network !== "open" && value.network !== "blocked") errors.push('"network" must be "open" or "blocked".');
  if (!isStringArray(value.sensitiveReadDeny)) errors.push('"sensitiveReadDeny" must be an array of strings.');

  if (!value.protectedPaths || !isStringArray(value.protectedPaths.block) || !isStringArray(value.protectedPaths.approval)) {
    errors.push('"protectedPaths.block" and "protectedPaths.approval" must be arrays of strings.');
  }
  if (!value.bashPolicy || !isStringArray(value.bashPolicy.directBlock) || !isStringArray(value.bashPolicy.requireApproval)) {
    errors.push('"bashPolicy.directBlock" and "bashPolicy.requireApproval" must be arrays of strings.');
  }
  if (!value.dcg || typeof value.dcg.enabled !== "boolean") {
    errors.push('"dcg.enabled" must be a boolean.');
  } else {
    for (const key of ["onDeny", "onIndeterminate", "onError"]) {
      if (!ACTIONS.has(value.dcg[key])) errors.push(`"dcg.${key}" must be one of: allow, notify, confirm, block.`);
    }
  }

  return errors.length > 0 ? { ok: false, error: errors.join(" ") } : { ok: true, config: value };
}

export async function loadConfig(cwd) {
  const configPath = getGuardConfigPath(cwd);
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    const validation = validateConfig(parsed);
    return validation.ok ? { kind: "valid", path: configPath, config: validation.config } : { kind: "invalid", path: configPath, error: validation.error };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { kind: "missing", path: configPath };
    if (error instanceof SyntaxError) return { kind: "invalid", path: configPath, error: `Invalid JSON: ${error.message}` };
    throw error;
  }
}

export async function writeConfig(cwd, config) {
  const configPath = getGuardConfigPath(cwd);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serializeConfig(config), "utf8");
  return configPath;
}

export async function initConfig(cwd) {
  const existing = await loadConfig(cwd);
  if (existing.kind !== "missing") return { created: false, reason: existing.kind === "invalid" ? "exists-invalid" : "exists", path: existing.path };
  const config = createDefaultConfig();
  const path = await writeConfig(cwd, config);
  return { created: true, path, config };
}
