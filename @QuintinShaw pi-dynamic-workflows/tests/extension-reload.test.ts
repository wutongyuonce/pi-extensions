import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  takeWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  const pending = new Map<number, { resolve: (v: unknown) => void }>();
  let callIndex = 0;
  return {
    resolve: (index: number, value: unknown = "done") => pending.get(index)?.resolve(value),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: unknown) => void }) {
        const index = callIndex++;
        return new Promise((resolve) => {
          pending.set(index, { resolve });
        });
      },
    },
  };
}

const twoAgentScript = `export const meta = { name: 'two_agent_ttl', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

/** Run with isolated cwd + HOME so the real manager's persistence stays sandboxed. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-reload-ttl-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-reload-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

function runtime(cwd: string): WorkflowReloadRuntime {
  return {
    cwd,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: { marker: cwd } as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
  };
}

test("reload handoff transfers the exact live runtime once", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-once`;
  const value = runtime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  assert.equal(takeWorkflowRuntime(cwd), value);
  assert.equal(takeWorkflowRuntime(cwd), undefined, "a second extension generation cannot claim it twice");
});

test("a changed package version is rejected and its live runs are paused for recovery", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-version`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    extensionVersion: `${WORKFLOW_EXTENSION_VERSION}-next`,
    manager: {
      // Stranded pause must walk live in-memory runs, not the session-filtered
      // listRuns() view (which hides runs whose frozen sessionId no longer
      // matches the bound session after a replacement).
      listLiveRuns: () => [
        { runId: "running-1", status: "running" },
        { runId: "paused-1", status: "paused" },
        { runId: "done-1", status: "completed" },
      ],
      listRuns: () => {
        throw new Error("pauseStranded must not call session-filtered listRuns()");
      },
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  const claim = claimWorkflowRuntime(cwd);

  assert.equal(claim.compatible, undefined);
  assert.ok(claim.versionMismatch);
  assert.equal(claim.versionMismatch, value);
  assert.equal(pauseStrandedWorkflowRuntime(claim.versionMismatch), 1);
  assert.deepEqual(paused, ["running-1"]);
});

test("a handoff nobody claims before its TTL expires pauses any still-running run", async () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-ttl-expiry`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    manager: {
      listLiveRuns: () => [
        { runId: "running-1", status: "running" },
        { runId: "done-1", status: "completed" },
      ],
      listRuns: () => {
        throw new Error("pauseStranded must not call session-filtered listRuns()");
      },
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value, 10);
  // Nobody ever claims it (simulating a reload that failed or never happened).
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(paused, ["running-1"], "the stranded running run must be paused, not left to burn tokens");
  assert.equal(takeWorkflowRuntime(cwd), undefined, "the expired entry must be gone so it can't be claimed later");
});

test("pauseStranded walks live runs even when listRuns is session-filtered empty", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-live-vs-filtered`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    manager: {
      // After setSessionId(B), listRuns() returns [] for a run still owned by A.
      listRuns: () => [],
      listLiveRuns: () => [{ runId: "orphan-of-session-A", status: "running" }],
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };

  assert.equal(pauseStrandedWorkflowRuntime(value), 1);
  assert.deepEqual(paused, ["orphan-of-session-A"]);
});

test(
  "a real in-flight run left stranded past the TTL is paused with its journal persisted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 finish so it lands in the journal; agent 2 stays pending
    // forever, so the run is still "running" when the handoff expires.
    da.resolve(0, "first-result");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.getRun(runId)?.status, "running", "run must still be in flight when the TTL fires");

    const value: WorkflowReloadRuntime = {
      cwd,
      extensionVersion: WORKFLOW_EXTENSION_VERSION,
      manager: manager as unknown as WorkflowReloadRuntime["manager"],
      effort: { level: "high" },
    };
    discardWorkflowRuntime(cwd);
    handoffWorkflowRuntime(value, 10);

    // Nobody ever claims it (simulating a reload that failed or never started).
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(manager.getRun(runId)?.status, "paused", "stranded run must be paused, not left running forever");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.ok(persisted?.journal && persisted.journal.length >= 1, "agent 1's result must be journaled to disk");
    assert.equal(takeWorkflowRuntime(cwd), undefined, "expired entry must be gone so it can't be claimed later");
  }),
);

test("reload handoff is a single process-wide slot; last stage wins; stale discard is a no-op", () => {
  const cwdA = `/tmp/reload-handoff-${process.pid}-a`;
  const cwdB = `/tmp/reload-handoff-${process.pid}-b`;
  const first = runtime(cwdA);
  const replacement = runtime(cwdA);
  const other = runtime(cwdB);
  discardWorkflowRuntime();

  handoffWorkflowRuntime(first);
  handoffWorkflowRuntime(replacement);
  // Stale identity discard must not clear the newer slot.
  discardWorkflowRuntime(cwdA, first);
  assert.equal(takeWorkflowRuntime(), replacement, "stale cleanup cannot delete a newer generation");

  handoffWorkflowRuntime(other);
  // Claim via process.cwd() (factory path) still gets the staged runtime even
  // when its project cwd differs from the launch directory.
  assert.equal(claimWorkflowRuntime(process.cwd()).compatible, other);
  assert.equal(takeWorkflowRuntime(), undefined, "slot is empty after claim");
});

test("handoff staged under a session project cwd is claimable via process.cwd() (Pi launch-dir model)", () => {
  const launch = process.cwd();
  const project = `/tmp/reload-handoff-${process.pid}-project`;
  discardWorkflowRuntime();

  const mgr = {
    getCwd: () => project,
    listLiveRuns: () => [],
    listRuns: () => [],
    pause: () => false,
  };
  const value: WorkflowReloadRuntime = {
    cwd: project,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: mgr as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
  };
  handoffWorkflowRuntime(value);

  // Factory only knows process.cwd() === launch, which differs from project.
  assert.notEqual(resolve(launch), resolve(project));
  const claim = claimWorkflowRuntime(launch);
  assert.equal(claim.compatible, value, "factory must claim the project manager via the process-wide slot");
  assert.equal(resolve(claim.compatible?.manager.getCwd()), resolve(project));
});

test("overwriting a staged handoff pauses the displaced runtime's live runs", () => {
  discardWorkflowRuntime();
  const paused: string[] = [];
  const first: WorkflowReloadRuntime = {
    cwd: `/tmp/reload-handoff-${process.pid}-overwrite-a`,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: {
      listLiveRuns: () => [{ runId: "running-a", status: "running" }],
      listRuns: () => [],
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
      getCwd: () => `/tmp/reload-handoff-${process.pid}-overwrite-a`,
    } as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
  };
  const second = runtime(`/tmp/reload-handoff-${process.pid}-overwrite-b`);

  handoffWorkflowRuntime(first);
  handoffWorkflowRuntime(second);

  assert.deepEqual(paused, ["running-a"], "displaced staged runtime must be paused, not left burning tokens");
  assert.equal(takeWorkflowRuntime(), second, "slot holds only the latest staged runtime");
  discardWorkflowRuntime();
});
