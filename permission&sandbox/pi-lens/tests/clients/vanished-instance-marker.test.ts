/**
 * Tests for the vanished-instance marker (#1123 item 2 — instance health).
 *
 * `detectVanishedInstances` is pure (fake liveness predicate, no real
 * process.kill). `logVanishedInstances` is exercised with the real function
 * against a mocked `logSessionStart` so the exact log line shape is asserted
 * without touching the real sessionstart.log file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceEntry } from "../../clients/instance-registry.js";

const logSessionStartSpy = vi.fn();
vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: (msg: string) => logSessionStartSpy(msg),
}));

import {
	detectVanishedInstances,
	logVanishedInstances,
} from "../../clients/vanished-instance-marker.js";

function instance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: 1,
		startedAt: "2026-08-07T00:00:00.000Z",
		projectRoot: "/proj",
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 500 * 1024 * 1024,
		heartbeatAt: "2026-08-07T01:00:00.000Z",
		...overrides,
	};
}

function alivePids(...pids: number[]): (pid: number) => boolean {
	const set = new Set(pids);
	return (pid) => set.has(pid);
}

describe("detectVanishedInstances (pure)", () => {
	it("flags a registry entry whose pid is confirmed dead", () => {
		const reg = [
			instance({
				pid: 42,
				rssBytes: 600 * 1024 * 1024,
				heartbeatAt: "2026-08-07T01:23:00.000Z",
			}),
		];
		const vanished = detectVanishedInstances(reg, alivePids());
		expect(vanished).toEqual([
			{
				pid: 42,
				lastSeenAt: "2026-08-07T01:23:00.000Z",
				rssBytes: 600 * 1024 * 1024,
			},
		]);
	});

	it("does not flag a live-pid entry — that instance is still running, not vanished", () => {
		const reg = [instance({ pid: 42 })];
		const vanished = detectVanishedInstances(reg, alivePids(42));
		expect(vanished).toHaveLength(0);
	});

	it("an empty registry (the clean-shutdown case: deregisterInstance already removed the entry) yields nothing", () => {
		const vanished = detectVanishedInstances([], alivePids());
		expect(vanished).toHaveLength(0);
	});

	it("treats an ambiguous liveness signal (ESRCH-only-dead contract) as alive, never vanished", () => {
		// isPidAlive returning true for an "unverifiable" pid must not be flagged.
		const reg = [instance({ pid: 7 })];
		const vanished = detectVanishedInstances(reg, () => true);
		expect(vanished).toHaveLength(0);
	});

	it("handles multiple dead-pid entries independently", () => {
		const reg = [
			instance({ pid: 1, heartbeatAt: "t1" }),
			instance({ pid: 2, heartbeatAt: "t2" }),
			instance({ pid: 3, heartbeatAt: "t3" }),
		];
		const vanished = detectVanishedInstances(reg, alivePids(2));
		expect(vanished.map((v) => v.pid).sort()).toEqual([1, 3]);
	});
});

describe("logVanishedInstances (fail-then-pass wiring)", () => {
	beforeEach(() => {
		logSessionStartSpy.mockClear();
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("logs one line for a dead-pid entry lacking clean shutdown, with pid/lastSeen/RSS", () => {
		// FAILS on code with no marker at all (nothing calls logSessionStart here);
		// PASSES once logVanishedInstances is wired to detect + log.
		const reg = [
			instance({
				pid: 4242,
				heartbeatAt: "2026-08-06T23:00:00.000Z",
				rssBytes: 734003200,
			}),
		];
		logVanishedInstances(reg, alivePids());

		expect(logSessionStartSpy).toHaveBeenCalledTimes(1);
		const line = logSessionStartSpy.mock.calls[0][0] as string;
		expect(line).toContain("previous instance pid 4242");
		expect(line).toContain("2026-08-06T23:00:00.000Z");
		expect(line).toContain("700MB"); // 734003200 bytes ≈ 700MB
		expect(line).toContain("exited without shutdown");
	});

	it("logs nothing for a clean-shutdown entry (pid alive, or entry already removed)", () => {
		const reg = [instance({ pid: 4242 })];
		logVanishedInstances(reg, alivePids(4242));
		expect(logSessionStartSpy).not.toHaveBeenCalled();
	});

	it("logs nothing when the registry has no entries at all (deregisterInstance already ran)", () => {
		logVanishedInstances([], alivePids());
		expect(logSessionStartSpy).not.toHaveBeenCalled();
	});

	it("never throws even if isPidAlive itself throws (best-effort observability)", () => {
		const reg = [instance({ pid: 1 })];
		expect(() =>
			logVanishedInstances(reg, () => {
				throw new Error("boom");
			}),
		).not.toThrow();
	});
});
