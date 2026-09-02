import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeSandboxAdapter } from "../src/runtime-sandbox.mjs";

function createRuntime(checkDependenciesResult) {
  const calls = {
    initialize: [],
    updateConfig: [],
    wrapWithSandbox: [],
    reset: 0,
  };

  return {
    calls,
    SandboxManager: {
      checkDependencies() {
        return checkDependenciesResult;
      },
      async initialize(config) {
        calls.initialize.push(config);
      },
      updateConfig(config) {
        calls.updateConfig.push(config);
      },
      async wrapWithSandbox(command) {
        calls.wrapWithSandbox.push(command);
        return `wrapped:${command}`;
      },
      async reset() {
        calls.reset += 1;
      },
    },
  };
}

test("runtime sandbox adapter accepts boolean dependency success results", async () => {
  const runtime = createRuntime(true);
  const adapter = await createRuntimeSandboxAdapter(runtime);
  const config = { ripgrep: { command: "rg" } };

  await adapter.apply(config);
  await adapter.apply(config);
  const wrapped = await adapter.wrap("echo hi");
  await adapter.reset();

  assert.equal(runtime.calls.initialize.length, 1);
  assert.equal(runtime.calls.updateConfig.length, 1);
  assert.deepEqual(runtime.calls.wrapWithSandbox, ["echo hi"]);
  assert.equal(wrapped, "wrapped:echo hi");
  assert.equal(runtime.calls.reset, 1);
});

test("runtime sandbox adapter rejects boolean dependency failures", async () => {
  const runtime = createRuntime(false);
  const adapter = await createRuntimeSandboxAdapter(runtime);

  await assert.rejects(() => adapter.apply({}), /dependencies are unavailable/i);
  assert.equal(runtime.calls.initialize.length, 0);
});

test("runtime sandbox adapter still supports object-style dependency errors", async () => {
  const runtime = createRuntime({ errors: ["socat not installed"], warnings: [] });
  const adapter = await createRuntimeSandboxAdapter(runtime);

  await assert.rejects(() => adapter.apply({}), /socat not installed/);
  assert.equal(runtime.calls.initialize.length, 0);
});
