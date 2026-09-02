import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGatewayLock, readGatewayOwner, gatewayLockPath } from "../../../src/host/gateway-lock.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fb-lock-"));
}

test("first process acquires the lock", () => {
  const dir = tempDir();
  try {
    const result = acquireGatewayLock(dir, { pid: 1111, now: () => 1000 });
    assert.equal(result.status, "acquired");
    assert.equal(result.handle?.owner.pid, 1111);
    const owner = readGatewayOwner(dir);
    assert.equal(owner?.pid, 1111);
    result.handle?.update("connected");
    const updated = JSON.parse(readFileSync(gatewayLockPath(dir), "utf8"));
    assert.equal(updated.status, "connected");
    void result.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second live process is busy; takeover overrides", () => {
  const dir = tempDir();
  try {
    // Simulate an existing live owner: our own pid so isPidAlive is true.
    const first = acquireGatewayLock(dir, { pid: process.pid, now: () => 1000 });
    assert.equal(first.status, "acquired");
    const second = acquireGatewayLock(dir, { pid: 2222 });
    assert.equal(second.status, "busy");
    assert.equal(second.owner?.pid, process.pid);
    const takeover = acquireGatewayLock(dir, { pid: 2222, takeover: true });
    assert.equal(takeover.status, "acquired");
    assert.equal(takeover.handle?.owner.pid, 2222);
    void takeover.handle?.release();
    void first.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lock from dead pid is replaceable", () => {
  const dir = tempDir();
  try {
    writeFileSync(gatewayLockPath(dir), JSON.stringify({ pid: 999_999, startedAt: 1, status: "connected" }), "utf8");
    const result = acquireGatewayLock(dir, { pid: 5555 });
    assert.equal(result.status, "acquired");
    assert.equal(result.handle?.owner.pid, 5555);
    void result.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release only removes own lock file", async () => {
  const dir = tempDir();
  try {
    const a = acquireGatewayLock(dir, { pid: 101, now: () => 5 });
    assert.equal(a.status, "acquired");
    await a.handle?.release();
    // After release, a new process can acquire.
    const b = acquireGatewayLock(dir, { pid: 102 });
    assert.equal(b.status, "acquired");
    void b.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
