/**
 * subagent-result-consumption.test.ts — issue #62.
 *
 * `TaskOutput` is the join point pi-tasks exposes for a `TaskExecute` subagent, but
 * it used to report only `Task #N [status] — subagent <id>`: the model had to follow
 * up with `TaskGet` to read the result it had just waited for, and pi-subagents was
 * never told the result had been read. Its completion notification therefore still
 * arrived — after the parent had answered — and cost another model turn to dismiss.
 *
 * The two halves are tested together because they are one contract: TaskOutput hands
 * the result over, and handing it over is what consumes it. The consume RPC is
 * best-effort and unversioned — an older pi-subagents has no handler for the channel
 * and simply keeps notifying, which is today's behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockPi } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

describe("TaskOutput result consumption", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Agent task", description: "d", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
  });

  afterEach(() => { rpc.unsub(); });

  it("returns the agent's result to the blocking caller", async () => {
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.complete("agent-1", "TASK_EXECUTE_AGENT_OK");

    expect((await pending).content[0].text).toBe(
      "Task #1 [completed] — subagent agent-1\n\nTASK_EXECUTE_AGENT_OK",
    );
  });

  it("consumes the result, so no completion notification follows the answer", async () => {
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.complete("agent-1", "TASK_EXECUTE_AGENT_OK");
    await pending;
    await rpc.afterNudgeHold();

    expect(rpc.consumed).toEqual(["agent-1"]);
    expect(rpc.notified).toEqual([]);
  });

  it("consumes a result read after the fact, not only one waited for", async () => {
    rpc.complete("agent-1", "TASK_EXECUTE_AGENT_OK");
    await flush();
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 });

    expect(res.content[0].text).toContain("TASK_EXECUTE_AGENT_OK");
    expect(rpc.consumed).toEqual(["agent-1"]);
  });

  it("returns the failure and consumes it too", async () => {
    // Seeded with output from an earlier run, which the failure listener drops —
    // so the error is what `result ?? lastError` finds, with no precedence rule here.
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { result: "earlier output" } });
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    rpc.fail("agent-1", "boom");
    // The failure listener reverts the task to pending so it can be retried.
    expect((await pending).content[0].text).toBe("Task #1 [pending] — subagent agent-1\n\nError: boom");

    await rpc.afterNudgeHold();
    expect(rpc.consumed).toEqual(["agent-1"]);
    expect(rpc.notified).toEqual([]);
  });

  it("leaves the notification alone while the agent is still running", async () => {
    // Nothing has been read here — the notification is the only thing that will
    // wake the parent when the agent finishes, so it must survive.
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 });
    expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
    expect(rpc.consumed).toEqual([]);

    rpc.complete("agent-1", "TASK_EXECUTE_AGENT_OK");
    await rpc.afterNudgeHold();
    expect(rpc.notified).toEqual(["agent-1"]);
  });

  it("still hands over the result when pi-subagents predates the consume channel", async () => {
    // Backward compatibility: the consume RPC is fire-and-forget and outside the
    // version handshake, so a pi-subagents with no handler for it must leave the
    // read untouched — result inline, notification delivered as it always was.
    rpc.unsub();
    const legacy = installSubagentsMock(mock.pi, { withoutConsume: true });
    try {
      await mock.executeTool("TaskCreate", { subject: "Second", description: "d", agentType: "general-purpose" });
      await mock.executeTool("TaskExecute", { task_ids: ["2"] });

      const pending = mock.executeTool("TaskOutput", { task_id: "2", block: true, timeout: 5000 });
      await flush();
      legacy.complete("agent-1", "TASK_EXECUTE_AGENT_OK");

      expect((await pending).content[0].text).toBe(
        "Task #2 [completed] — subagent agent-1\n\nTASK_EXECUTE_AGENT_OK",
      );
      await legacy.afterNudgeHold();
      expect(legacy.notified).toEqual(["agent-1"]);
    } finally {
      legacy.unsub();
    }
  });

  it("leaves the notification alone when the blocking wait times out", async () => {
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 30 });
    expect(res.content[0].text).toContain("[in_progress]");
    expect(rpc.consumed).toEqual([]);

    rpc.complete("agent-1", "late but still the first anyone hears of it");
    await rpc.afterNudgeHold();
    expect(rpc.notified).toEqual(["agent-1"]);
  });
});
