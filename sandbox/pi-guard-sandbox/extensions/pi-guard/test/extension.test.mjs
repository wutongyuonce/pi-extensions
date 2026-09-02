import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../src/constants.mjs";
import { writeConfig } from "../src/config.mjs";
import { getGuardArgumentCompletions, registerPiGuard, renderStatus } from "../src/extension.mjs";

function fakePi() {
  const events = new Map();
  return {
    events, tools: [], commands: [],
    on(name, handler) { events.set(name, handler); },
    registerTool(tool) { this.tools.push(tool); },
    registerCommand(name, command) { this.commands.push({ name, ...command }); },
  };
}
function context(mode, cwd = process.cwd()) {
  const notices = []; const statuses = [];
  return { mode, cwd, notices, statuses, ui: {
    notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), confirm: async () => false,
  } };
}
const dependencies = {
  createSandbox: async () => ({ async apply() {}, async wrap(command) { return command; }, async reset() {} }),
  createLocalOps: () => ({ async exec() { return {}; } }),
  createBashTool: () => ({ async execute() { return {}; } }),
  createDcgClient: () => ({ async detect() { return true; }, async evaluate() { return { kind: "allow" }; } }),
};

test("non-TUI modes do not initialize sandbox, DCG, tools, status, or blocking", async () => {
  const pi = fakePi();
  let sandboxCalls = 0;
  let dcgCalls = 0;
  registerPiGuard(pi, {
    ...dependencies,
    createSandbox: async () => { sandboxCalls += 1; return dependencies.createSandbox(); },
    createDcgClient: () => { dcgCalls += 1; return dependencies.createDcgClient(); },
  });
  const ctx = context("json");
  await pi.events.get("session_start")({}, ctx);
  const blocked = await pi.events.get("tool_call")({ toolName: "bash", input: { command: "sudo rm -rf /" } }, ctx);
  assert.equal(sandboxCalls, 0);
  assert.equal(dcgCalls, 0);
  assert.equal(pi.tools.length, 0);
  assert.equal(pi.commands.length, 0);
  assert.equal(ctx.statuses.length, 0);
  assert.equal(blocked, undefined);
});

test("TUI registers guarded tool, status UI, slash status, and autocomplete", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-guard-ext-"));
  await writeConfig(cwd, createDefaultConfig());
  const pi = fakePi();
  registerPiGuard(pi, dependencies);
  const ctx = context("tui", cwd);
  await pi.events.get("session_start")({}, ctx);
  assert.equal(pi.tools.length, 1);
  assert.equal(pi.commands[0].name, "guard");
  assert.match(ctx.statuses.at(-1)[1], /^\[Guard:/);
  await pi.commands[0].handler("status", ctx);
  assert.match(ctx.notices.at(-1)[0], /Slash overrides last only/);
  assert.deepEqual(getGuardArgumentCompletions("sandbox o").map((item) => item.value), ["sandbox on", "sandbox off"]);
  assert.ok(getGuardArgumentCompletions("").some((item) => item.value === "network off"));
});

test("status rendering names all DCG actions and runtime override information", () => {
  const rendered = renderStatus({ guardActive: true, sandboxEnabled: true, sandboxActive: true, mode: "workspace-write", network: "open", dcgConfigured: true, dcgEnabled: true, dcgAvailable: true, usingDcg: true, dcgError: false, config: { dcg: { onDeny: "confirm", onIndeterminate: "notify", onError: "notify" } }, overrides: ["sandbox"], configPath: "/tmp/.pi/pi-guard.json", workspaceRoot: "/tmp" });
  assert.match(rendered, /DCG actions: deny=confirm/);
  assert.match(rendered, /Runtime overrides: sandbox/);
});
