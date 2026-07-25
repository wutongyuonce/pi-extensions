import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardController } from "../src/guard.mjs";
import { createDefaultConfig } from "../src/constants.mjs";
import { writeConfig } from "../src/config.mjs";
import { buildSandboxRuntimeConfig } from "../src/sandbox-config.mjs";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "pi-guard-"));
}

function createSandbox() {
  return {
    applied: [],
    wrapped: [],
    extraMaskCalls: [],
    async apply(config) {
      this.applied.push(config);
    },
    async wrap(command, extraMaskPaths) {
      this.wrapped.push(command);
      this.extraMaskCalls.push(extraMaskPaths ?? []);
      return `wrapped:${command}`;
    },
    async reset() {},
  };
}

async function readyGuard(mode = "workspace-write") {
  const cwd = tempWorkspace();
  const config = createDefaultConfig();
  config.mode = mode;
  await writeConfig(cwd, config);
  const sandbox = createSandbox();
  const guard = createGuardController({ cwd, sandbox });
  await guard.refresh();
  return { cwd, guard, sandbox, config };
}

test("sandbox config enforces readonly and workspace-write write roots", () => {
  const cwd = tempWorkspace();
  const readonly = buildSandboxRuntimeConfig({ cwd, config: { ...createDefaultConfig(), mode: "readonly" } });
  const writable = buildSandboxRuntimeConfig({ cwd, config: { ...createDefaultConfig(), mode: "workspace-write" } });

  assert.deepEqual(readonly.filesystem.allowWrite, ["/tmp"]);
  assert.equal(writable.filesystem.allowWrite.includes(cwd), true);
  assert.equal(writable.filesystem.denyWrite.some((entry) => entry.endsWith(".pi/pi-guard.json")), true);
});

test("sandbox config resolves symlinked sensitive read paths to real targets", () => {
  const cwd = tempWorkspace();
  const targetRoot = join(cwd, "real-home");
  mkdirSync(join(targetRoot, ".aws"), { recursive: true });
  const aliasRoot = join(cwd, "alias-home");
  mkdirSync(aliasRoot, { recursive: true });
  symlinkSync(join(targetRoot, ".aws"), join(aliasRoot, ".aws"));

  const config = createDefaultConfig();
  config.mode = "readonly";
  config.sensitiveReadDeny = [join(aliasRoot, ".aws")];

  const runtimeConfig = buildSandboxRuntimeConfig({ cwd, config });
  assert.deepEqual(runtimeConfig.filesystem.denyRead, [join(targetRoot, ".aws")]);
});

test("dangerous bash commands are blocked or approval-gated", async () => {
  const { guard } = await readyGuard();

  const directBlock = await guard.handleToolCall({ toolName: "bash", input: { command: "sudo rm -rf /tmp/x" }, hasUI: true, requestApproval: async () => true });
  const noUiApproval = await guard.handleToolCall({ toolName: "bash", input: { command: "rm -rf src" }, hasUI: false });
  const approved = await guard.handleToolCall({ toolName: "bash", input: { command: "git reset --hard" }, hasUI: true, requestApproval: async () => true });

  assert.equal(directBlock.status, "block");
  assert.match(directBlock.reason, /sudo/);
  assert.equal(noUiApproval.status, "block");
  assert.equal(approved.status, "allow");
});

test("bash preparation uses sandbox when guard is active and local mode when uninitialized", async () => {
  const { guard, sandbox } = await readyGuard("readonly");
  const prepared = await guard.prepareBash("echo hi");

  assert.equal(prepared.mode, "sandbox");
  assert.equal(prepared.command, "wrapped:echo hi");
  assert.deepEqual(sandbox.wrapped, ["echo hi"]);

  const uninitialized = createGuardController({ cwd: tempWorkspace(), sandbox: createSandbox() });
  await uninitialized.refresh();
  const local = await uninitialized.prepareBash("echo hi");
  assert.equal(local.mode, "local");
});

test("prepareBash masks sensitive read paths in sandbox command", async () => {
  const cwd = tempWorkspace();
  const config = createDefaultConfig();
  config.mode = "readonly";
  config.sensitiveReadDeny = ["~/.ssh", "~/.npmrc"];
  await writeConfig(cwd, config);
  const sandbox = createSandbox();
  const guard = createGuardController({ cwd, sandbox });
  await guard.refresh();

  await guard.prepareBash("echo hi");
  const maskPaths = sandbox.extraMaskCalls[0];

  assert.ok(maskPaths.some(({ path }) => path.endsWith(".ssh")), "ssh dir should be masked");
  assert.ok(maskPaths.some(({ path }) => path.endsWith(".npmrc")), "npmrc file should be masked");
  assert.ok(maskPaths.find(({ path }) => path.endsWith(".ssh")).isDir, "ssh is a directory");
  assert.equal(maskPaths.find(({ path }) => path.endsWith(".npmrc")).isDir, false, "npmrc is a file");
});

test("sandbox-unavailable blocks bash execution preparation", async () => {
  const cwd = tempWorkspace();
  const config = createDefaultConfig();
  await writeConfig(cwd, config);
  const sandbox = createSandbox();
  sandbox.apply = async () => {
    throw new Error("socat missing");
  };
  const guard = createGuardController({ cwd, sandbox });
  await guard.refresh();

  await assert.rejects(() => guard.prepareBash("echo hi"), /socat missing/);
});

test("prepareBash inherits host environment variables", async () => {
  const cwd = tempWorkspace();
  const config = createDefaultConfig();
  await writeConfig(cwd, config);
  const sandbox = createSandbox();
  const guard = createGuardController({ cwd, sandbox });
  await guard.refresh();

  process.env.PI_GUARD_TEST_VAR = "hello-from-host";
  try {
    const prepared = await guard.prepareBash("echo hi");
    assert.equal(prepared.env.PI_GUARD_TEST_VAR, "hello-from-host");
    assert.equal(prepared.env.HOME, process.env.HOME);
  } finally {
    delete process.env.PI_GUARD_TEST_VAR;
  }
});

test("prepareBash uses real HOME and overrides cache dirs", async () => {
  const cwd = tempWorkspace();
  const config = createDefaultConfig();
  await writeConfig(cwd, config);
  const sandbox = createSandbox();
  const guard = createGuardController({ cwd, sandbox });
  await guard.refresh();

  const prepared = await guard.prepareBash("echo hi");

  assert.equal(prepared.env.HOME, process.env.HOME, "HOME should be real home");
  assert.equal(prepared.env.TMPDIR, "/tmp");
  assert.equal(prepared.env.XDG_CACHE_HOME, "/tmp/.cache");
  assert.equal(prepared.env.npm_config_cache, "/tmp/.npm");
  assert.equal(prepared.env.PIP_CACHE_DIR, "/tmp/.pip-cache");
});
