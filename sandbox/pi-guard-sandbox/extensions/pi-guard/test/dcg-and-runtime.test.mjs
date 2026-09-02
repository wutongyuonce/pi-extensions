import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../src/constants.mjs";
import { writeConfig, validateConfig } from "../src/config.mjs";
import { createDcgClient, parseDcgAvailability, parseDcgResult, runProcess } from "../src/dcg.mjs";
import { createGuardController, formatGuardFooter } from "../src/guard.mjs";
import { renderStatus } from "../src/extension.mjs";

function workspace() { return mkdtempSync(join(tmpdir(), "pi-guard-dcg-")); }
function sandbox() { return { applied: [], async apply(c) { this.applied.push(c); }, async wrap(c) { return `wrapped:${c}`; }, async reset() {} }; }
function json(decision, fields = {}) { return JSON.stringify({ decision, ...fields }); }
async function ready({ responses = [], config = createDefaultConfig(), client } = {}) {
  const cwd = workspace();
  await writeConfig(cwd, config);
  const calls = [];
  const dcg = client ?? createDcgClient({ run: async (_bin, args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "dcg 0.6.9" };
    return responses.shift() ?? { code: 0, stdout: json("allow") };
  } });
  const guard = createGuardController({ cwd, sandbox: sandbox(), dcg });
  await guard.refresh();
  return { guard, calls, cwd };
}

const input = { toolName: "bash", input: { command: "rm -rf src" }, hasUI: true, requestApproval: async () => true };

test("old configuration gains DCG and runtime-switch defaults", () => {
  const old = { mode: "workspace-write", sensitiveReadDeny: [], protectedPaths: { block: [], approval: [] }, bashPolicy: { directBlock: [], requireApproval: [] } };
  const result = validateConfig(old);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.dcg, { enabled: true, onDeny: "confirm", onIndeterminate: "notify", onError: "notify" });
  assert.equal(result.config.sandbox.enabled, true);
  const invalid = validateConfig({ ...old, dcg: { enabled: true, onDeny: "maybe" } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /dcg.onDeny/);
});

test("missing DCG uses the built-in Bash policy", async () => {
  const cwd = workspace();
  const config = createDefaultConfig();
  await writeConfig(cwd, config);
  const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const dcg = createDcgClient({ run: async () => ({ error: missing }) });
  const guard = createGuardController({ cwd, sandbox: sandbox(), dcg });
  await guard.refresh();
  const result = await guard.handleToolCall({ ...input, input: { command: "sudo echo nope" } });
  assert.equal(guard.getStatus().usingDcg, false);
  assert.equal(result.status, "block");
});

test("healthy DCG allow replaces rather than repeats built-in Bash policy", async () => {
  const { guard, calls } = await ready();
  const result = await guard.handleToolCall({ ...input, input: { command: "sudo echo allowed-by-fake" } });
  assert.equal(result.status, "allow");
  assert.equal(calls.filter((args) => args[1] === "test").length, 1);
});

test("DCG deny defaults to a TUI confirmation", async () => {
  const { guard } = await ready({ responses: [{ code: 1, stdout: json("deny", { reason: "recursive delete", rule_id: "core.filesystem:rm-rf", severity: "high" }) }] });
  let body = "";
  const accepted = await guard.handleToolCall({ ...input, requestApproval: async ({ body: value }) => { body = value; return true; } });
  assert.equal(accepted.status, "allow");
  assert.match(body, /DCG identified a destructive command/);
  assert.match(body, /core.filesystem:rm-rf/);
});

test("deny respects allow, notify, and block actions", async () => {
  for (const action of ["allow", "notify", "block"]) {
    const config = createDefaultConfig(); config.dcg.onDeny = action;
    const { guard } = await ready({ config, responses: [{ code: 1, stdout: json("deny", { reason: "danger" }) }] });
    let notifications = 0;
    const result = await guard.handleToolCall({ ...input, notify: () => { notifications += 1; } });
    assert.equal(result.status, action === "block" ? "block" : "allow");
    assert.equal(notifications, action === "notify" ? 1 : 0);
  }
});

test("indeterminate notifies and continues by default, with confirm and block configurable", async () => {
  for (const action of ["notify", "confirm", "block"]) {
    const config = createDefaultConfig(); config.dcg.onIndeterminate = action;
    const { guard } = await ready({ config, responses: [{ code: 1, stdout: json("indeterminate", { reason: "analysis budget" }) }] });
    let notice = "";
    const result = await guard.handleToolCall({ ...input, notify: (message) => { notice = message; }, requestApproval: async () => true });
    assert.equal(result.status, action === "block" ? "block" : "allow");
    if (action === "notify") assert.match(notice, /not a confirmed dangerous command/);
  }
});

test("DCG spawn error, timeout, invalid JSON, signal, and unknown code are integration errors", () => {
  for (const result of [
    { error: new Error("missing") }, { timedOut: true }, { code: 0, stdout: "not json" }, { code: null, signal: "SIGTERM" }, { code: 3, stdout: "{}" },
  ]) assert.equal(parseDcgResult(result).kind, "error");
});

test("availability distinguishes missing from executable failures", () => {
  const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
  assert.equal(parseDcgAvailability({ error: missing }).kind, "missing");
  for (const result of [{ timedOut: true }, { code: 1 }, { code: null, signal: "SIGTERM" }, { error: new Error("EACCES") }]) {
    assert.equal(parseDcgAvailability(result).kind, "error");
  }
  assert.equal(parseDcgAvailability({ code: 0 }).kind, "available");
});

test("process boundary force-kills a child that ignores SIGTERM", async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 300, killGraceMs: 50 });
  assert.equal(result.timedOut, true);
  assert.equal(result.forceKilled, true);
  assert.ok(Date.now() - started < 1_000, "timeout must remain bounded");
  assert.equal(parseDcgResult(result).kind, "error");
});

test("continuous DCG errors notify once, recover, then notify again", async () => {
  const { guard } = await ready({ responses: [
    { timedOut: true }, { timedOut: true }, { code: 0, stdout: json("allow") }, { code: 0, stdout: "bad" },
  ] });
  let notifications = 0;
  for (let i = 0; i < 4; i += 1) await guard.handleToolCall({ ...input, notify: () => { notifications += 1; } });
  assert.equal(notifications, 2);
  assert.equal(guard.getStatus().dcgError, true);
  assert.match(guard.getStatus().footer, /DCG:error/);
});

test("DCG detection errors use onError, retry, and accurately report the policy", async () => {
  const detections = [
    { kind: "error", reason: "DCG availability check timed out." },
    { kind: "error", reason: "DCG availability check timed out." },
    { kind: "available" },
  ];
  const client = {
    async detect() { return detections.shift(); },
    async evaluate() { return { kind: "allow" }; },
  };
  const { guard } = await ready({ client });
  assert.equal(guard.getStatus().dcgAvailability, "error");
  assert.match(guard.getStatus().footer, /DCG:error/);
  assert.match(renderStatus(guard.getStatus()), /Bash policy: DCG \(error, retrying\)/);
  let notifications = 0;
  const blocked = await guard.handleToolCall({ ...input, notify: () => { notifications += 1; } });
  assert.equal(blocked.status, "allow");
  assert.equal(notifications, 1);
  const recovered = await guard.handleToolCall({ ...input, notify: () => { notifications += 1; } });
  assert.equal(recovered.status, "allow");
  assert.equal(guard.getStatus().dcgError, false);
  assert.equal(guard.getStatus().bashPolicy, "dcg");
});

test("DCG detection error respects onError block", async () => {
  const config = createDefaultConfig();
  config.dcg.onError = "block";
  const client = { async detect() { return { kind: "error", reason: "DCG check failed." }; }, async evaluate() { throw new Error("not reached"); } };
  const { guard } = await ready({ config, client });
  const decision = await guard.handleToolCall(input);
  assert.equal(decision.status, "block");
});

test("every inactive-to-active DCG transition detects and enables healthy DCG", async () => {
  for (const { setup, expectedDetections } of [
    { setup: (config) => { config.enabled = false; }, expectedDetections: 1 },
    { setup: (config) => { config.dcg.enabled = false; }, expectedDetections: 1 },
    { setup: () => {}, expectedDetections: 2 },
  ]) {
    const config = createDefaultConfig();
    setup(config);
    let detections = 0;
    const client = { async detect() { detections += 1; return { kind: "available" }; }, async evaluate() { return { kind: "allow" }; } };
    const { guard } = await ready({ config, client });
    if (!config.enabled) await guard.setGuardEnabled(true);
    else if (!config.dcg.enabled) await guard.setDcgEnabled(true);
    else { await guard.setGuardEnabled(false); await guard.setGuardEnabled(true); }
    assert.equal(guard.getStatus().bashPolicy, "dcg");
    assert.equal((await guard.handleToolCall({ ...input, input: { command: "sudo safe-through-dcg" } })).status, "allow");
    assert.equal(detections, expectedDetections);
  }
});

test("the three runtime switches are independent and footer text follows the matrix", async () => {
  const { guard } = await ready();
  assert.equal(guard.getStatus().footer, "[Guard: workspace-write · DCG]");
  await guard.setNetwork("blocked");
  assert.equal(guard.getStatus().footer, "[Guard: workspace-write · net:blocked · DCG]");
  await guard.setSandboxEnabled(false);
  assert.equal(guard.getStatus().footer, "[Guard: sandbox-off · DCG]");
  await guard.setDcgEnabled(false);
  assert.equal(guard.getStatus().footer, "[Guard: sandbox-off · built-in]");
  await guard.setGuardEnabled(false);
  assert.equal(guard.getStatus().footer, "[Guard: OFF]");
  assert.equal((await guard.handleToolCall({ ...input, input: { command: "sudo anything" } })).status, "allow");
});

test("a new controller restores configuration defaults after runtime overrides", async () => {
  const { cwd, guard } = await ready();
  await guard.setMode("readonly");
  await guard.setSandboxEnabled(false);
  const next = createGuardController({ cwd, sandbox: sandbox(), dcg: createDcgClient({ run: async () => ({ code: 0, stdout: "dcg" }) }) });
  await next.refresh();
  assert.equal(next.getStatus().mode, "workspace-write");
  assert.equal(next.getStatus().sandboxEnabled, true);
  assert.deepEqual(next.getStatus().overrides, []);
});

test("footer formatter covers read-only and built-in states", () => {
  assert.equal(formatGuardFooter({ guardActive: true, sandboxEnabled: true, kind: "readonly", mode: "readonly", network: "open", usingDcg: true, dcgError: false }), "[Guard: read-only · DCG]");
  assert.equal(formatGuardFooter({ guardActive: true, sandboxEnabled: true, kind: "workspace-write", mode: "workspace-write", network: "open", usingDcg: false, dcgError: false }), "[Guard: workspace-write · built-in]");
});
