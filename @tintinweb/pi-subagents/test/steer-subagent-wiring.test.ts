/**
 * steer-subagent-wiring.test.ts — the steer_subagent path that can silently
 * swallow user input.
 *
 * A steer issued between spawn and session creation is parked on the record as
 * `pendingSteers` and flushed later by AgentManager. The tool tells the caller
 * the message was queued, so if the queue is dropped or overwritten the user is
 * told their correction landed when it never will. That whole branch had no
 * coverage — the only existing assertion on this tool is that a nested agent id
 * reports "Agent not found".
 *
 * The plain rejections (unknown id, non-running status) are deliberately not
 * tested: they are single-line guards whose failure is immediately visible in
 * the tool's own reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent, steerAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

// steerAgent and runAgent are module-level mocks shared by every case here, so
// call history has to be reset or a "was never called" assertion depends on the
// order the cases happen to run in.
beforeEach(() => {
  vi.mocked(steerAgent).mockReset();
  vi.mocked(runAgent).mockReset();
});

/** Enough of an AgentSession for the manager's and index's onSessionCreated hooks. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

/** A runAgent that never settles, and only creates its session when told to. */
function heldRun() {
  let createSession: ((session: any) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        createSession = (session: any) => opts.onSessionCreated?.(session);
      }) as any,
  );
  return {
    create(session: any) {
      createSession?.(session);
    },
  };
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "steer wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const steer = (tools: Map<string, any>, agent_id: string, message: string) =>
  tools.get("steer_subagent").execute("tc-steer", { agent_id, message }, undefined, undefined, ctx());

describe("steer_subagent before the session exists", () => {
  it("queues the message on the record and says so", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await steer(tools, id, "change course");
    expect(textOf(result)).toContain("queued");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "change course" });

    await lifecycle.get("session_shutdown")?.();
  });

  it("appends a second queued steer instead of replacing the first", async () => {
    // Overwriting would lose the earlier correction while still reporting success.
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();

    await steer(tools, id, "first");
    await steer(tools, id, "second");

    // Observe the queue through its only real consumer: the flush on session
    // creation, which must deliver both, in order.
    const sessionSteer = vi.fn().mockResolvedValue(undefined);
    run.create(fakeSession({ steer: sessionSteer }));
    await flush();

    expect(sessionSteer.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not call steerAgent — there is no session to steer yet", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();
    await steer(tools, id, "hello");

    expect(steerAgent).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("steer_subagent once the session exists", () => {
  it("reports failure and emits no event when the steer throws", async () => {
    // The event is emitted only AFTER steerAgent resolves, so a failed steer
    // must not announce itself as delivered.
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockRejectedValueOnce(new Error("session closed"));
    const result = await steer(tools, id, "too late");

    expect(textOf(result)).toContain("Failed to steer agent");
    expect(textOf(result)).toContain("session closed");
    expect(pi.events.emit).not.toHaveBeenCalledWith(
      "subagents:steered",
      expect.objectContaining({ message: "too late" }),
    );

    await lifecycle.get("session_shutdown")?.();
  });

  it("delivers through steerAgent and announces the steer on success", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockResolvedValueOnce(undefined as any);
    const result = await steer(tools, id, "refocus");

    expect(steerAgent).toHaveBeenCalledWith(expect.anything(), "refocus");
    expect(textOf(result)).toContain("Steering message sent");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "refocus" });

    await lifecycle.get("session_shutdown")?.();
  });
});
