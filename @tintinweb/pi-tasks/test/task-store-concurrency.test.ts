/**
 * Shared task lists: several pi sessions pointing at the same file. Each mutation
 * takes the lock, re-reads the file, applies, and writes back — these tests pin that
 * contract, since the alternative (mutating stale in-memory state) silently drops
 * the other session's writes.
 *
 * Not covered on purpose: retry-to-exhaustion against a live lock holder. That is
 * 100 retries x 50ms of busy wait — five seconds of wall clock for one assertion.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

// A seam inside the critical section. save() ends with renameSync, so a hook there
// runs while the store holds the lock — the only way to stage a lock changing hands
// mid-operation, since acquire and release are both internal to withLock.
const renameHook = vi.hoisted(() => ({ current: null as null | (() => void) }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameHook.current?.();
      return actual.renameSync(...args);
    },
  };
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-lock-"));
  file = join(dir, "tasks.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore — shared file access", () => {
  it("assigns distinct IDs when two sessions create tasks in turn", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);

    const first = a.create("From A", "d");
    const second = b.create("From B", "d");

    expect(first.id).toBe("1");
    expect(second.id).toBe("2");
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["From A", "From B"]);
  });

  it("does not lose the other session's writes when both mutate the same task", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Original", "d");

    a.update("1", { status: "in_progress" });
    b.update("1", { subject: "Renamed by B" });

    const [task] = new TaskStore(file).list();
    expect(task.status).toBe("in_progress");
    expect(task.subject).toBe("Renamed by B");
  });

  it("sees another session's new tasks without being reconstructed", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("From A", "d");

    expect(b.list().map(t => t.subject)).toEqual(["From A"]);
    expect(b.get("1")?.subject).toBe("From A");
  });

  it("sees another session's deletions", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Doomed", "d");
    a.delete("1");

    expect(b.list()).toEqual([]);
    expect(b.get("1")).toBeUndefined();
  });

  it("reclaims a lock left behind by a dead process", () => {
    // A crashed session leaves its lock file on disk. Without stale-lock detection
    // every later mutation would block for the full retry budget and then throw.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(`${file}.lock`, String(dead.pid));

    const store = new TaskStore(file);
    expect(() => store.create("After crash", "d")).not.toThrow();
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["After crash"]);
  });

  it("reclaims a lock file that never got a PID written to it", () => {
    // acquireLock creates the lock file and then writes its PID. A crash in between
    // leaves an empty lock naming nobody — which used to be unrecoverable: every
    // later mutation burned the full retry budget and threw, permanently, until
    // someone deleted the file by hand.
    writeFileSync(`${file}.lock`, "");

    const store = new TaskStore(file);
    expect(() => store.create("After crash", "d")).not.toThrow();
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["After crash"]);
  });

  it("reclaims a lock file holding garbage", () => {
    writeFileSync(`${file}.lock`, "not-a-pid");

    const store = new TaskStore(file);
    expect(() => store.create("After garbage lock", "d")).not.toThrow();
  });

  it("still reads the PID out of a lock written in the pid:token format", () => {
    // The lock token carries a unique suffix so a holder can recognise its own
    // lock. Staleness detection reads the PID off the front of that token — if the
    // format ever stops leading with the PID, every crashed lock silently becomes
    // unrecoverable-for-five-seconds again.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(`${file}.lock`, `${dead.pid}:11111111-2222-3333-4444-555555555555`);

    const store = new TaskStore(file);
    const started = Date.now();
    expect(() => store.create("After crash", "d")).not.toThrow();
    // Reclaimed on the first poll, not after the full retry budget (5s) expired.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not delete a lock that a successor now holds", () => {
    // A lock can be reclaimed out from under a live holder: isProcessRunning reads
    // the local process table, so a session in another PID namespace (a container,
    // or a list shared over NFS) reads our PID as dead. Releasing must then be a
    // no-op instead of deleting the successor's lock and letting two sessions write.
    const store = new TaskStore(file);
    const successor = `${process.pid}:00000000-0000-0000-0000-000000000000`;

    // renameSync is the last thing save() does, so this fires inside the critical
    // section — after our lock was written, before it is released.
    renameHook.current = () => { writeFileSync(`${file}.lock`, successor); };
    try {
      store.create("Task", "d");
    } finally {
      renameHook.current = null;
    }

    expect(readFileSync(`${file}.lock`, "utf-8")).toBe(successor);
  });

  it("removes its own lock even after reclaiming a stale one", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(`${file}.lock`, String(dead.pid));

    new TaskStore(file).create("Task", "d");

    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("leaves no lock or temp file behind after a mutation", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");
    store.update("1", { status: "completed" });
    store.clearCompleted();

    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("TaskStore — snapshot and seed", () => {
  it("snapshots the latest state written by another session", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Written by A", "d");

    expect(b.snapshot().tasks.map(t => t.subject)).toEqual(["Written by A"]);
  });

  it("seeds an empty store and carries the ID counter over", () => {
    const parent = new TaskStore(file);
    parent.create("One", "d");
    parent.create("Two", "d");
    const snapshot = parent.snapshot();

    const childFile = join(dir, "child.json");
    const child = new TaskStore(childFile);
    child.seed(snapshot);

    expect(child.list().map(t => t.subject)).toEqual(["One", "Two"]);
    // Continues from the parent's counter rather than colliding on "1".
    expect(child.create("Three", "d").id).toBe("3");
  });

  it("is a no-op on a store that already has tasks, so re-seeding never duplicates", () => {
    const parent = new TaskStore(file);
    parent.create("One", "d");
    const snapshot = parent.snapshot();

    const childFile = join(dir, "child.json");
    new TaskStore(childFile).seed(snapshot);
    // Re-pointing at the already-seeded file and seeding again must change nothing.
    const reopened = new TaskStore(childFile);
    reopened.seed(snapshot);

    expect(reopened.list().map(t => t.subject)).toEqual(["One"]);
  });

  it("does not write the parent's file when the seeded copy is mutated", () => {
    const parent = new TaskStore(file);
    parent.create("Shared", "d");

    const childFile = join(dir, "child.json");
    const child = new TaskStore(childFile);
    child.seed(parent.snapshot());
    child.create("Child only", "d");

    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["Shared"]);
  });
});
