import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { ProcessTracker } from "../src/process-tracker.js";

describe("ProcessTracker", () => {
  let tracker: ProcessTracker;

  beforeEach(() => {
    tracker = new ProcessTracker();
  });

  it("returns undefined for untracked task", () => {
    expect(tracker.getOutput("999")).toBeUndefined();
    expect(tracker.getProcess("999")).toBeUndefined();
  });

  it("tracks a process and captures stdout", async () => {
    const proc = spawn("echo", ["hello world"]);
    tracker.track("1", proc, "echo hello world");

    await new Promise<void>((r) => proc.on("close", r));
    // Small delay for event processing
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out).toBeDefined();
    expect(out!.output).toContain("hello world");
    expect(out!.status).toBe("completed");
    expect(out!.exitCode).toBe(0);
    expect(out!.command).toBe("echo hello world");
    expect(out!.startedAt).toBeGreaterThan(0);
    expect(out!.completedAt).toBeGreaterThan(0);
  });

  it("tracks a process and captures stderr", async () => {
    const proc = spawn("sh", ["-c", "echo errdata >&2"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.output).toContain("errdata");
  });

  it("reports error status for non-zero exit", async () => {
    const proc = spawn("sh", ["-c", "exit 42"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("error");
    expect(out!.exitCode).toBe(42);
  });

  it("waitForCompletion returns immediately for already-completed process", async () => {
    const proc = spawn("echo", ["done"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = await tracker.waitForCompletion("1", 1000);
    expect(out).toBeDefined();
    expect(out!.status).toBe("completed");
  });

  it("waitForCompletion returns undefined for untracked task", async () => {
    const out = await tracker.waitForCompletion("999", 1000);
    expect(out).toBeUndefined();
  });

  it("waitForCompletion waits for process to finish", async () => {
    const proc = spawn("sh", ["-c", "sleep 0.1 && echo waited"]);
    tracker.track("1", proc);

    const out = await tracker.waitForCompletion("1", 5000);
    expect(out).toBeDefined();
    expect(out!.output).toContain("waited");
    expect(out!.status).toBe("completed");
  });

  it("waitForCompletion times out if process takes too long", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    const out = await tracker.waitForCompletion("1", 200);
    expect(out).toBeDefined();
    expect(out!.status).toBe("running");

    // Cleanup
    proc.kill("SIGKILL");
  });

  it("stop sends SIGTERM and marks process stopped", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    // Small delay to let process start
    await new Promise((r) => setTimeout(r, 50));

    const stopped = await tracker.stop("1");
    expect(stopped).toBe(true);

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("stopped");
    expect(out!.completedAt).toBeGreaterThan(0);
  });

  it("stop returns false for untracked task", async () => {
    expect(await tracker.stop("999")).toBe(false);
  });

  it("stop returns false for already-completed process", async () => {
    const proc = spawn("echo", ["quick"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    expect(await tracker.stop("1")).toBe(false);
  });

  it("getProcess returns the background process record", () => {
    const proc = spawn("echo", ["test"]);
    tracker.track("1", proc, "echo test");

    const bp = tracker.getProcess("1");
    expect(bp).toBeDefined();
    expect(bp!.taskId).toBe("1");
    expect(bp!.command).toBe("echo test");
    expect(bp!.status).toBe("running");
    expect(bp!.pid).toBeGreaterThan(0);

    proc.kill("SIGKILL");
  });

  it("handles process error event", async () => {
    const proc = spawn("nonexistent-binary-that-does-not-exist-xyz");
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("error", () => r()));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("error");
    expect(out!.output).toContain("Process error:");
  });

  it("waitForCompletion respects abort signal", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const out = await tracker.waitForCompletion("1", 60000, ac.signal);
    expect(out).toBeDefined();
    expect(out!.status).toBe("running");

    proc.kill("SIGKILL");
  });

  it("notifies waiters when process completes", async () => {
    const proc = spawn("sh", ["-c", "sleep 0.1"]);
    tracker.track("1", proc);

    const [r1, r2] = await Promise.all([
      tracker.waitForCompletion("1", 5000),
      tracker.waitForCompletion("1", 5000),
    ]);

    expect(r1!.status).toBe("completed");
    expect(r2!.status).toBe("completed");
  });
});
