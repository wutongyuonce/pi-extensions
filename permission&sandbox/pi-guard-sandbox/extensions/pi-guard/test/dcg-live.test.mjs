import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../src/constants.mjs";
import { writeConfig } from "../src/config.mjs";
import { createDcgClient } from "../src/dcg.mjs";
import { createGuardController } from "../src/guard.mjs";

const bin = process.env.DCG_BIN ?? "dcg";
const available = (() => {
  try {
    return spawnSync(bin, ["--version"], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

function workspace() { return mkdtempSync(join(tmpdir(), "pi-guard-live-")); }
function sandbox() { return { async apply() {}, async wrap(c) { return c; }, async reset() {} }; }

async function liveGuard() {
  const cwd = workspace();
  await writeConfig(cwd, createDefaultConfig());
  const guard = createGuardController({ cwd, sandbox: sandbox(), dcg: createDcgClient({ bin }) });
  await guard.refresh();
  return guard;
}

test("live DCG allows a safe command", { skip: !available }, async () => {
  const guard = await liveGuard();
  assert.equal(guard.getStatus().bashPolicy, "dcg");
  const result = await guard.handleToolCall({ toolName: "bash", input: { command: "ls -la" } });
  assert.equal(result.status, "allow");
});

test("live DCG denies a destructive command through the confirm path", { skip: !available }, async () => {
  const guard = await liveGuard();
  const result = await guard.handleToolCall({
    toolName: "bash",
    input: { command: "git reset --hard HEAD~1" },
    hasUI: true,
    requestApproval: async () => false,
  });
  assert.equal(result.status, "block");
  assert.match(result.reason, /User denied|DCG/);
});

test("live DCG status reports healthy DCG in the footer", { skip: !available }, async () => {
  const guard = await liveGuard();
  assert.equal(guard.getStatus().usingDcg, true);
  assert.match(guard.getStatus().footer, /DCG]/);
});
