/**
 * Tests for the TaskOutput and TaskStop tools — subagent-backed tasks, agent-ID
 * resolution, blocking waits, and the error paths.
 *
 * Note: nothing in the extension calls `tracker.track()` (pi's bash tool has no
 * background mode yet), so the ProcessTracker branches of these tools are not
 * reachable from a tool call. ProcessTracker itself is covered in
 * process-tracker.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockPi } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

/** Create an agent-backed task and launch it, returning the harness. */
async function launchAgentTask(mock: ReturnType<typeof mockPi>, subject = "Agent task") {
  await mock.executeTool("TaskCreate", { subject, description: "d", agentType: "general-purpose" });
  await mock.executeTool("TaskExecute", { task_ids: ["1"] });
}

describe("TaskOutput", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => { rpc.unsub(); });

  it("returns the current status without waiting when block is false", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 });
    expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
  });

  it("resolves a blocking wait when the agent completes", async () => {
    await launchAgentTask(mock);
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    expect((await pending).content[0].text).toContain("[completed]");
  });

  it("resolves a blocking wait when the agent fails", async () => {
    await launchAgentTask(mock);
    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 5000 });
    await flush();
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "boom", status: "error" });
    // The failure listener reverts the task to pending so it can be retried.
    expect((await pending).content[0].text).toContain("[pending]");
  });

  it("gives up after the timeout when the agent never reports back", async () => {
    await launchAgentTask(mock);
    const started = Date.now();
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(res.content[0].text).toContain("[in_progress]");
  });

  it("stops waiting when the tool call is aborted", async () => {
    await launchAgentTask(mock);
    const controller = new AbortController();
    const pending = mock.executeToolWithSignal(
      "TaskOutput",
      { task_id: "1", block: true, timeout: 30000 },
      controller.signal,
    );
    await flush();
    controller.abort();
    expect((await pending).content[0].text).toContain("[in_progress]");
  });

  it("does not wait for a task that is no longer in_progress", async () => {
    await launchAgentTask(mock);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    // block=true with a long timeout — this must return immediately, not hang.
    const res = await mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 30000 });
    expect(res.content[0].text).toContain("[completed]");
  });

  it("throws for an unknown ID", async () => {
    await expect(mock.executeTool("TaskOutput", { task_id: "99", block: false, timeout: 30000 }))
      .rejects.toThrow("No task found with ID 99");
  });

  it("rejects an empty ID instead of matching an arbitrary agent", async () => {
    // Every agent ID starts with "", so an empty id would prefix-match whichever
    // entry the agent map happens to yield first.
    await launchAgentTask(mock);
    await expect(mock.executeTool("TaskOutput", { task_id: "", block: false, timeout: 30000 }))
      .rejects.toThrow("task_id is required");
  });

  it("throws for a task with neither a process nor an agent", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 }))
      .rejects.toThrow("No background process for task 1");
  });
});

describe("TaskOutput — agent ID lookups", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports the resolved task, not a stale pre-wait snapshot", async () => {
    // Regression: `resolvedId` was computed from agentTaskMap and then discarded —
    // the status was re-read with the caller's agent ID, which never matches a task,
    // so the tool fell back to the Task object captured before the wait. Only
    // reproducible file-backed: an in-memory store hands back the live object that
    // the completion listener mutates, which masks the stale read.
    dir = mkdtempSync(join(tmpdir(), "pi-tasks-output-"));
    process.env.PI_TASKS = join(dir, "tasks.json");

    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    try {
      await launchAgentTask(mock);

      const pending = mock.executeTool("TaskOutput", { task_id: "agent-1", block: true, timeout: 5000 });
      await flush();
      mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });

      expect((await pending).content[0].text).toBe("Task #1 [completed] — subagent agent-1\n\ndone");
    } finally {
      rpc.unsub();
    }
  });

  it("resolves an agent ID to its task when not blocking", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    try {
      await launchAgentTask(mock);
      const res = await mock.executeTool("TaskOutput", { task_id: "agent-1", block: false, timeout: 30000 });
      expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
    } finally {
      rpc.unsub();
    }
  });

  it("resolves a unique agent ID prefix", async () => {
    // Partial prefixes are documented as accepted, and take the startsWith branch
    // rather than the equality one.
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    try {
      await launchAgentTask(mock);
      const res = await mock.executeTool("TaskOutput", { task_id: "agent-", block: false, timeout: 30000 });
      expect(res.content[0].text).toBe("Task #1 [in_progress] — subagent agent-1");
    } finally {
      rpc.unsub();
    }
  });
});

describe("TaskStop", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => { rpc.unsub(); });

  it("stops the agent and completes the task", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("completes the task when stopped by agent ID", async () => {
    // Regression: the agent was stopped and success reported, but the store update
    // used the caller's agent ID instead of the resolved task ID — so the task stayed
    // in_progress forever and the widget spinner kept animating.
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "agent-1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("completes the task when stopped by a unique agent ID prefix", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { task_id: "agent-" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: completed");
  });

  it("accepts the deprecated shell_id parameter", async () => {
    await launchAgentTask(mock);
    const res = await mock.executeTool("TaskStop", { shell_id: "1" });

    expect(res.content[0].text).toBe("Task #1 stopped successfully");
    expect(rpc.stopped).toEqual(["agent-1"]);
  });

  it("throws when neither task_id nor shell_id is given", async () => {
    await expect(mock.executeTool("TaskStop", {})).rejects.toThrow("task_id is required");
  });

  it("throws for a task with no running agent", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });
    await expect(mock.executeTool("TaskStop", { task_id: "1" }))
      .rejects.toThrow("No running background process for task 1");
  });

  it("throws for an unknown ID", async () => {
    await expect(mock.executeTool("TaskStop", { task_id: "99" }))
      .rejects.toThrow("No running background process for task 99");
  });

  it("does not re-stop an already completed agent task", async () => {
    await launchAgentTask(mock);
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    await expect(mock.executeTool("TaskStop", { task_id: "1" }))
      .rejects.toThrow("No running background process for task 1");
    expect(rpc.stopped).toEqual([]);
  });
});
