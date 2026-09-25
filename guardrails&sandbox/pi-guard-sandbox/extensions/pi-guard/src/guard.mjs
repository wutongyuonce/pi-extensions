import { statSync } from "node:fs";
import { getGuardConfigPath, initConfig, loadConfig } from "./config.mjs";
import { buildSandboxRuntimeConfig } from "./sandbox-config.mjs";
import { evaluateToolCall } from "./tool-policy.mjs";
import { createDcgClient, formatDcgReason } from "./dcg.mjs";
import { getWorkspaceRoot, normalizeSensitivePathPattern } from "./path-utils.mjs";

const DISPLAY_MODES = { readonly: "read-only" };
export function displayMode(mode) { return DISPLAY_MODES[mode] ?? mode ?? "(none)"; }

export function formatGuardFooter(status) {
  if (!status.guardActive) return "[Guard: OFF]";
  const policy = status.dcgError ? "DCG:error" : status.usingDcg ? "DCG" : "built-in";
  if (!status.sandboxEnabled) return `[Guard: sandbox-off · ${policy}]`;
  if (status.kind === "sandbox-unavailable") return `[Guard: sandbox-unavailable · ${policy}]`;
  if (status.kind === "uninitialized" || status.kind === "invalid-config") return `[Guard: ${status.kind} · ${policy}]`;
  const parts = [displayMode(status.mode)];
  if (status.network === "blocked") parts.push("net:blocked");
  parts.push(policy);
  return `[Guard: ${parts.join(" · ")}]`;
}

export function formatGuardStatus(status) {
  if (status.kind === "uninitialized" || status.kind === "invalid-config") return `Guard: ${status.kind}`;
  if (!status.guardActive) return "Guard: OFF";
  if (status.kind === "sandbox-unavailable") return `Guard: sandbox-unavailable (${displayMode(status.mode)})`;
  return `Guard: ${displayMode(status.mode)} · network: ${status.network ?? "open"}`;
}

function resolveSensitiveMaskPaths(patterns) {
  const result = [];
  for (const pattern of patterns) {
    const normalized = normalizeSensitivePathPattern(pattern);
    try { const s = statSync(normalized); result.push({ path: normalized, isDir: s.isDirectory() }); } catch { /* non-existent paths need no bwrap mask */ }
  }
  return result;
}

function overridesFor(defaults, overrides) {
  return Object.entries(overrides).filter(([key, value]) => value !== undefined && defaults[key] !== value).map(([key]) => key);
}

export function createGuardController({ cwd, sandbox, dcg = createDcgClient() } = {}) {
  if (!cwd) throw new Error("cwd is required");
  let state = {
    kind: "uninitialized", config: null, configPath: getGuardConfigPath(cwd), workspaceRoot: getWorkspaceRoot(cwd), error: null,
    sandboxActive: false, dcgAvailability: "inactive", dcgError: false, dcgErrorReason: null, dcgErrorNotified: false,
    overrides: { guard: undefined, sandbox: undefined, dcg: undefined, mode: undefined, network: undefined },
  };

  function effective() {
    const config = state.config;
    if (!config) return { guard: false, sandbox: false, dcg: false, mode: null, network: undefined };
    const guard = state.overrides.guard ?? config.enabled;
    return {
      guard,
      sandbox: guard && (state.overrides.sandbox ?? config.sandbox.enabled),
      dcg: guard && (state.overrides.dcg ?? config.dcg.enabled),
      mode: state.overrides.mode ?? config.mode,
      network: state.overrides.network ?? config.network,
    };
  }

  async function syncSandbox() {
    const active = effective();
    if (!active.sandbox) { state.sandboxActive = false; await sandbox?.reset?.(); return; }
    const runtimeConfig = buildSandboxRuntimeConfig({ cwd, config: { ...state.config, mode: active.mode, network: active.network } });
    await sandbox?.apply?.(runtimeConfig);
    state.sandboxActive = true;
  }

  function normalizeDcgAvailability(result) {
    // Retain a small compatibility seam for injected test clients from the
    // first integration iteration; production clients always return objects.
    if (result === true) return { kind: "available" };
    if (result === false) return { kind: "missing" };
    if (["missing", "available", "error"].includes(result?.kind)) return result;
    return { kind: "error", reason: "DCG availability check returned an invalid result." };
  }

  function clearDcgError() {
    state.dcgError = false;
    state.dcgErrorReason = null;
    state.dcgErrorNotified = false;
  }

  async function detectDcgAvailability() {
    let raw;
    try { raw = await dcg.detect(); }
    catch (error) { raw = { kind: "error", reason: `DCG availability check threw: ${error instanceof Error ? error.message : String(error)}` }; }
    const result = normalizeDcgAvailability(raw);
    state.dcgAvailability = result.kind;
    if (result.kind === "error") {
      state.dcgError = true;
      state.dcgErrorReason = result.reason;
    } else if (result.kind === "missing") {
      clearDcgError();
    }
    return result;
  }

  async function refresh() {
    const loaded = await loadConfig(cwd);
    state.configPath = loaded.path;
    state.overrides = { guard: undefined, sandbox: undefined, dcg: undefined, mode: undefined, network: undefined };
    state.dcgAvailability = "inactive"; clearDcgError();
    if (loaded.kind !== "valid") {
      state = { ...state, kind: loaded.kind === "missing" ? "uninitialized" : "invalid-config", config: null, error: loaded.error ?? null, sandboxActive: false };
      await sandbox?.reset?.();
      return getStatus();
    }
    state = { ...state, kind: loaded.config.mode, config: loaded.config, error: null, sandboxActive: false };
    const active = effective();
    if (active.dcg) await detectDcgAvailability();
    try { await syncSandbox(); state.kind = active.mode; }
    catch (error) { state.kind = "sandbox-unavailable"; state.error = error instanceof Error ? error.message : String(error); state.sandboxActive = false; }
    return getStatus();
  }

  function getStatus() {
    const active = effective();
    const defaults = state.config ? { guard: state.config.enabled, sandbox: state.config.sandbox.enabled, dcg: state.config.dcg.enabled, mode: state.config.mode, network: state.config.network } : {};
    const status = {
      kind: state.kind, mode: active.mode, network: active.network, config: state.config, configPath: state.configPath, workspaceRoot: state.workspaceRoot, error: state.error,
      guardActive: active.guard, sandboxEnabled: active.sandbox, sandboxActive: active.sandbox && state.sandboxActive,
      dcgConfigured: Boolean(state.config?.dcg.enabled), dcgEnabled: active.dcg,
      dcgAvailability: state.dcgAvailability, dcgAvailable: state.dcgAvailability === "available", dcgError: state.dcgError, dcgErrorReason: state.dcgErrorReason,
      usingDcg: active.dcg && state.dcgAvailability === "available" && !state.dcgError,
      bashPolicy: active.dcg && state.dcgError ? "dcg-error" : active.dcg && state.dcgAvailability === "available" ? "dcg" : "built-in",
      overrides: overridesFor(defaults, state.overrides), scope: "agent tools only",
    };
    return { ...status, text: formatGuardStatus(status), footer: formatGuardFooter(status) };
  }

  async function initializeConfig() { const result = await initConfig(cwd); await refresh(); return { ...result, status: getStatus() }; }
  async function setRuntime(key, value) {
    if (!state.config) throw new Error("Guard is not initialized.");
    const wasDcgActive = effective().dcg;
    state.overrides[key] = value;
    try { await syncSandbox(); if (state.kind !== "sandbox-unavailable") state.kind = effective().mode; }
    catch (error) { state.kind = "sandbox-unavailable"; state.error = error.message; state.sandboxActive = false; }
    const isDcgActive = effective().dcg;
    if (!wasDcgActive && isDcgActive) await detectDcgAvailability();
    if (wasDcgActive && !isDcgActive) { state.dcgAvailability = "inactive"; clearDcgError(); }
    return getStatus();
  }
  async function setMode(mode) { if (!new Set(["readonly", "workspace-write"]).has(mode)) throw new Error(`Unsupported mode: ${mode}`); return setRuntime("mode", mode); }
  async function setNetwork(network) { if (!new Set(["open", "blocked"]).has(network)) throw new Error(`Unsupported network value: ${network}`); return setRuntime("network", network); }
  async function setGuardEnabled(enabled) { return setRuntime("guard", enabled); }
  async function setSandboxEnabled(enabled) { return setRuntime("sandbox", enabled); }
  async function setDcgEnabled(enabled) { return setRuntime("dcg", enabled); }

  async function applyDcgAction(kind, output, { hasUI, requestApproval, notify }) {
    const action = state.config.dcg[kind === "deny" ? "onDeny" : kind === "indeterminate" ? "onIndeterminate" : "onError"];
    const message = kind === "deny"
      ? `DCG identified a destructive command.\n${formatDcgReason(output, "DCG denied this command.")}`
      : kind === "indeterminate"
        ? `DCG could not complete a safety decision; this is not a confirmed dangerous command.\n${formatDcgReason(output, "")}`
        : output.reason;
    if (action === "allow") return { status: "allow" };
    if (action === "notify") { if (kind !== "error" || !state.dcgErrorNotified) notify?.(message, "warning"); return { status: "allow" }; }
    if (action === "block") return { status: "block", block: true, reason: message };
    if (!hasUI) return { status: "block", block: true, reason: `${message}\nNo TUI is available for approval.` };
    const approved = await requestApproval?.({ type: "dcg", title: kind === "deny" ? "DCG found a destructive command" : "DCG needs your decision", body: message });
    return approved ? { status: "allow" } : { status: "block", block: true, reason: "User denied DCG approval." };
  }

  async function handleToolCall({ toolName, input, hasUI, requestApproval, notify }) {
    const active = effective();
    if (!active.guard) return { status: "allow" };
    if (toolName === "bash" && active.sandbox && state.kind === "sandbox-unavailable") return { status: "block", block: true, reason: "Guard bash sandbox is unavailable." };
    if (toolName === "bash" && active.dcg && state.dcgAvailability === "error") {
      const detection = await detectDcgAvailability();
      if (detection.kind === "error") {
        const firstError = !state.dcgErrorNotified;
        const decision = await applyDcgAction("error", { reason: detection.reason }, { hasUI, requestApproval, notify: firstError ? notify : undefined });
        state.dcgErrorNotified = true;
        return decision;
      }
    }
    if (toolName === "bash" && active.dcg && state.dcgAvailability === "available") {
      let result;
      try { result = await dcg.evaluate(String(input.command ?? "")); }
      catch (error) { result = { kind: "error", reason: `DCG integration error: ${error instanceof Error ? error.message : String(error)}` }; }
      if (result.kind === "error") {
        const firstError = !state.dcgErrorNotified;
        state.dcgError = true;
        state.dcgErrorReason = result.reason;
        const decision = await applyDcgAction("error", result, { hasUI, requestApproval, notify: firstError ? notify : undefined });
        state.dcgErrorNotified = true;
        return decision;
      }
      clearDcgError();
      if (result.kind === "allow") return { status: "allow" };
      return applyDcgAction(result.kind, result.output, { hasUI, requestApproval, notify });
    }
    return evaluateToolCall({ cwd, config: { ...state.config, mode: active.mode }, statusKind: state.kind, toolName, input, hasUI, requestApproval });
  }

  async function prepareBash(command) {
    const active = effective();
    if (!active.guard || !active.sandbox) return { mode: "local", command };
    if (!state.sandboxActive) throw new Error(state.error || "Guard bash sandbox is unavailable.");
    const wrapped = await sandbox.wrap(command, resolveSensitiveMaskPaths(state.config.sensitiveReadDeny));
    return { mode: "sandbox", command: wrapped, env: { ...process.env, TMPDIR: "/tmp", XDG_CACHE_HOME: "/tmp/.cache", npm_config_cache: "/tmp/.npm", PIP_CACHE_DIR: "/tmp/.pip-cache" } };
  }

  return { refresh, getStatus, initializeConfig, setMode, setNetwork, setGuardEnabled, setSandboxEnabled, setDcgEnabled, handleToolCall, prepareBash };
}
