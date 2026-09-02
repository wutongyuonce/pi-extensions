#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createAttemptArtifactStore, RESULT_SCHEMA_VERSION } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-artifacts-"));

try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const store = await createAttemptArtifactStore({
    cwd,
    runId: "run_check_001",
    attemptId: "attempt_check_001",
  });

  const expectedAttemptDir = join(cwd, ".pi/agent/runs/run_check_001/attempts/attempt_check_001");
  assert.equal(store.attemptDir, expectedAttemptDir);
  await access(expectedAttemptDir);

  const stdoutRef = await store.writeTextArtifact("stdout", "hello stdout\n");
  const stderrRef = await store.writeTextArtifact("stderr", "hello stderr\n");
  const outputRef = await store.appendTextArtifact("output", "combined output\n");

  const result = await store.writeResult({
    backend: "headless",
    status: "completed",
    cwd,
    startedAt: "2026-06-07T00:00:00.000Z",
    completedAt: "2026-06-07T00:00:00.125Z",
    workspace: { mode: "shared", cwd },
    sandbox: { enabled: false },
    exitCode: 0,
    signal: null,
    artifacts: [stdoutRef, stderrRef, outputRef],
    correlationId: "corr_check",
    metadata: { contextLengthExceeded: false, model: "provider/model" },
  });

  const resultPath = join(expectedAttemptDir, "result.json");
  const persisted = JSON.parse(await readFile(resultPath, "utf8"));

  assert.deepEqual(persisted, result);
  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(result.runId, "run_check_001");
  assert.equal(result.attemptId, "attempt_check_001");
  assert.equal(result.correlationId, "corr_check");
  assert.equal(result.backend, "headless");
  assert.equal(result.status, "completed");
  assert.equal(result.failureKind, null);
  assert.equal(result.cwd, cwd);
  assert.equal(result.startedAt, "2026-06-07T00:00:00.000Z");
  assert.equal(result.completedAt, "2026-06-07T00:00:00.125Z");
  assert.equal(result.durationMs, 125);
  assert.equal(result.workspace.mode, "shared");
  assert.equal(result.workspace.cwd, cwd);
  assert.equal(result.workspace.worktreePath, null);
  assert.equal(result.sandbox.enabled, false);
  assert.equal("type" in result.sandbox, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.metadata.contextLengthExceeded, false);
  assert.equal(result.metadata.model, "provider/model");

  const artifactTypes = new Set(result.artifacts.map((artifact) => artifact.type));
  assert.deepEqual(artifactTypes, new Set(["stdout", "stderr", "output", "result"]));

  for (const artifact of result.artifacts) {
    assert.equal(isAbsolute(artifact.path), false, `${artifact.type} path should be relative`);
    assert.equal(artifact.path.split("/").includes(".."), false, `${artifact.type} path should not escape cwd`);
    assert.ok(
      artifact.path.startsWith(".pi/agent/runs/run_check_001/attempts/attempt_check_001/"),
      `${artifact.type} path should use stable run/attempt layout`,
    );
    await access(join(cwd, artifact.path));
  }

  console.log(
    JSON.stringify(
      {
        name: "check-artifacts",
        status: "completed",
        runId: result.runId,
        attemptId: result.attemptId,
        artifacts: result.artifacts.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
