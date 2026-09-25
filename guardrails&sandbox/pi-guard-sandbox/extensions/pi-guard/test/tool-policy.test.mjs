import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createGuardController } from "../src/guard.mjs";
import { createDefaultConfig } from "../src/constants.mjs";
import { writeConfig } from "../src/config.mjs";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "pi-guard-"));
}

function createSandbox() {
  return {
    async apply() {},
    async wrap(command) { return `wrapped:${command}`; },
    async reset() {},
  };
}

async function readyGuard(mode = "workspace-write") {
  const cwd = tempWorkspace();
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.txt"), "hello\n", "utf8");
  const config = createDefaultConfig();
  config.mode = mode;
  await writeConfig(cwd, config);
  const guard = createGuardController({ cwd, sandbox: createSandbox() });
  await guard.refresh();
  return { cwd, guard };
}

test("readonly rejects write and edit without approval", async () => {
  const { guard } = await readyGuard("readonly");

  const writeDecision = await guard.handleToolCall({ toolName: "write", input: { path: "src/a.txt" }, hasUI: true, requestApproval: async () => true });
  const editDecision = await guard.handleToolCall({ toolName: "edit", input: { path: "src/a.txt" }, hasUI: true, requestApproval: async () => true });

  assert.equal(writeDecision.status, "block");
  assert.equal(editDecision.status, "block");
  assert.match(writeDecision.reason, /read-only/);
});

test("workspace-write allows local write and approval-gates external write", async () => {
  const { cwd, guard } = await readyGuard("workspace-write");
  const external = join(cwd, "..", "outside.txt");

  const localDecision = await guard.handleToolCall({ toolName: "write", input: { path: "src/a.txt" }, hasUI: false });
  const deniedExternal = await guard.handleToolCall({ toolName: "write", input: { path: external }, hasUI: false });
  const approvedExternal = await guard.handleToolCall({ toolName: "write", input: { path: external }, hasUI: true, requestApproval: async () => true });

  assert.equal(localDecision.status, "allow");
  assert.equal(deniedExternal.status, "block");
  assert.equal(approvedExternal.status, "allow");
});

test("external reads are allowed except sensitive read paths", async () => {
  const { guard } = await readyGuard();

  const safeRead = await guard.handleToolCall({ toolName: "read", input: { path: "/etc/hosts" }, hasUI: false });
  const sensitiveRead = await guard.handleToolCall({ toolName: "read", input: { path: join(homedir(), ".ssh", "id_rsa") }, hasUI: false });

  assert.equal(safeRead.status, "allow");
  assert.equal(sensitiveRead.status, "block");
  assert.match(sensitiveRead.reason, /Sensitive read denied/);
});

test("sensitive read deny follows symlinked configured paths", async () => {
  const cwd = tempWorkspace();
  const realRoot = join(cwd, "real-home");
  mkdirSync(join(realRoot, ".aws"), { recursive: true });
  writeFileSync(join(realRoot, ".aws", "credentials"), "secret\n", "utf8");
  const aliasRoot = join(cwd, "alias-home");
  mkdirSync(aliasRoot, { recursive: true });
  symlinkSync(join(realRoot, ".aws"), join(aliasRoot, ".aws"));

  const config = createDefaultConfig();
  config.sensitiveReadDeny = [join(aliasRoot, ".aws")];
  await writeConfig(cwd, config);

  const guard = createGuardController({ cwd, sandbox: createSandbox() });
  await guard.refresh();

  const denied = await guard.handleToolCall({
    toolName: "read",
    input: { path: join(aliasRoot, ".aws", "credentials") },
    hasUI: false,
  });

  assert.equal(denied.status, "block");
  assert.match(denied.reason, /Sensitive read denied/);
});

test("protected paths block or ask according to config", async () => {
  const { guard } = await readyGuard();
  mkdirSync(join(guard.getStatus().workspaceRoot, ".git"), { recursive: true });

  const blocked = await guard.handleToolCall({ toolName: "write", input: { path: ".git/config" }, hasUI: true, requestApproval: async () => true });
  const denied = await guard.handleToolCall({ toolName: "write", input: { path: ".env" }, hasUI: true, requestApproval: async () => false });
  const approved = await guard.handleToolCall({ toolName: "edit", input: { path: ".pi/pi-guard.json" }, hasUI: true, requestApproval: async () => true });

  assert.equal(blocked.status, "block");
  assert.equal(denied.status, "block");
  assert.equal(approved.status, "allow");
});
