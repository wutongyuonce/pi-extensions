/**
 * schedule-params-wiring.test.ts — what the Agent tool actually persists when
 * `schedule` is set.
 *
 * A scheduled job's config is written to disk now and consumed at fire time,
 * possibly days later, in a session nobody is watching. So a field that fails to
 * reach the store — or reaches it with the wrong value — surfaces as an agent
 * that misbehaves long after the call that configured it, with no error anywhere.
 * That makes this the one part of the schedule branch worth pinning; the six
 * refusal messages next to it are straight-line guards that fail loudly at the
 * call site and are deliberately not tested.
 *
 * The job is read back through the real ScheduleStore rather than by spying on
 * `addJob`, so the assertion covers persistence too.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { getDefaultMaxTurns, normalizeMaxTurns } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const SESSION_ID = "sched-wiring-session";

function bootedCtx() {
  return ctx({
    sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
  });
}

/**
 * Boot the extension in a temp cwd, bind session_start (the scheduler is
 * inactive until then), schedule one agent, and read the job back off disk.
 */
async function scheduleAndReadBack(
  params: Record<string, unknown>,
): Promise<{ job: ScheduledSubagent; reply: string; restore: () => void }> {
  const hermetic = hermeticDir();
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);

  const c = bootedCtx();
  await lifecycle.get("session_start")?.({}, c);

  const reply = textOf(
    await tools.get("Agent").execute(
      "tc-sched",
      { prompt: "do the thing", description: "nightly sweep", schedule: "0 3 * * * *", ...params },
      undefined,
      undefined,
      c,
    ),
  );

  const store = new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID));
  const jobs = store.list();
  await lifecycle.get("session_shutdown")?.();
  expect(jobs, `expected one persisted job, reply was: ${reply}`).toHaveLength(1);
  return { job: jobs[0], reply, restore: hermetic.restore };
}

describe("Agent tool → persisted scheduled job", () => {
  it("persists the run-shaping params the job will fire with", async () => {
    const { job, restore } = await scheduleAndReadBack({
      subagent_type: "general-purpose",
      thinking: "high",
      isolated: true,
      isolation: "worktree",
    });
    try {
      expect(job.thinking).toBe("high");
      expect(job.isolated).toBe(true);
      expect(job.isolation).toBe("worktree");
      expect(job.prompt).toBe("do the thing");
      expect(job.enabled).toBe(true);
    } finally {
      restore();
    }
  });

  it("persists the normalized turn limit, not the raw parameter", async () => {
    // max_turns goes through normalizeMaxTurns and the agent-config/default
    // fallback chain before it is stored. Persisting the raw param instead
    // would give the scheduled run a different limit from an identical
    // immediate run — and only at fire time.
    const { job, restore } = await scheduleAndReadBack({
      subagent_type: "general-purpose",
      max_turns: 0, // 0 means "unlimited", not "zero turns"
    });
    try {
      expect(job.max_turns).toBe(normalizeMaxTurns(0));
    } finally {
      restore();
    }
  });

  it("falls back to the configured default turn limit when the call omits one", async () => {
    const { job, restore } = await scheduleAndReadBack({ subagent_type: "general-purpose" });
    try {
      expect(job.max_turns).toBe(normalizeMaxTurns(getDefaultMaxTurns()));
    } finally {
      restore();
    }
  });

  it("stores the caller's own subagent_type, not the fallback substitute", async () => {
    // The scheduler re-resolves the type at fire time, and the stored name is
    // what a user sees and edits in /agents. Baking in today's substitute would
    // permanently rewrite their job to an agent they never asked for.
    const { job, reply, restore } = await scheduleAndReadBack({ subagent_type: "does-not-exist" });
    try {
      expect(job.subagent_type).toBe("does-not-exist");
      expect(reply).toContain("Scheduled");
    } finally {
      restore();
    }
  });
});

// README documents three combinations that scheduling refuses. Each is a
// published contract an orchestrator reads before calling, and none was pinned
// (`grep "Cannot combine" test/` returned nothing) — so the wording could drift,
// or a guard could be dropped, without any test noticing. The exact strings are
// asserted because the ORDER of these guards decides which message a caller
// gets when two apply at once; a substring match would let a reordering pass.
describe("Agent tool → schedule restrictions", () => {
  /** Boot + bind, then make one scheduling call and return its reply text. */
  async function scheduleCall(
    params: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ): Promise<{ reply: string; jobCount: number; restore: () => void }> {
    const hermetic = hermeticDir(settings ? { settings } : {});
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const c = bootedCtx();
    await lifecycle.get("session_start")?.({}, c);

    const reply = textOf(
      await tools.get("Agent").execute(
        "tc-sched",
        {
          prompt: "do the thing",
          description: "nightly sweep",
          schedule: "0 3 * * * *",
          subagent_type: "general-purpose",
          ...params,
        },
        undefined,
        undefined,
        c,
      ),
    );

    let jobCount = 0;
    try {
      jobCount = new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID)).list().length;
    } catch { /* store never created — nothing was scheduled */ }
    await lifecycle.get("session_shutdown")?.();
    return { reply, jobCount, restore: hermetic.restore };
  }

  it("refuses `schedule` with `resume` — schedules create fresh agents", async () => {
    const { reply, jobCount, restore } = await scheduleCall({ resume: "agent-123" });
    try {
      expect(reply).toBe("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
      expect(jobCount).toBe(0); // refused, not scheduled-and-warned
    } finally {
      restore();
    }
  });

  it("refuses `schedule` with `inherit_context` — no parent conversation at fire time", async () => {
    const { reply, jobCount, restore } = await scheduleCall({ inherit_context: true });
    try {
      expect(reply).toBe(
        "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });

  it("refuses `schedule` with `run_in_background: false` rather than silently coercing it", async () => {
    // README:91 long claimed this parameter was "forced to true". It is not —
    // the call is refused. Silently flipping a parameter the caller explicitly
    // set is the failure mode #37 was filed about; refusing is the intended
    // behavior and this pins it.
    const { reply, jobCount, restore } = await scheduleCall({ run_in_background: false });
    try {
      expect(reply).toBe(
        "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });

  it("accepts `run_in_background: true` and an omitted `run_in_background`", async () => {
    // The mirror: only an explicit `false` is refused, so a caller that sets the
    // flag by habit is not blocked.
    for (const params of [{ run_in_background: true }, {}]) {
      const { reply, jobCount, restore } = await scheduleCall(params);
      try {
        expect(reply).toContain("Scheduled");
        expect(jobCount).toBe(1);
      } finally {
        restore();
      }
    }
  });

  it("refuses scheduling entirely when the project disabled it", async () => {
    const { reply, jobCount, restore } = await scheduleCall({}, { schedulingEnabled: false });
    try {
      expect(reply).toBe(
        "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });
});
