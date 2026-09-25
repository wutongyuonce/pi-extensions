import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";

function debugHandlesLogPath(): string {
	return path.join(getGlobalPiLensDir(), "debug-handles.log");
}

/**
 * `clients/debug-handles.ts` reads `PI_LENS_DEBUG_HANDLES` ONCE at module
 * load (institutionalizing the #1097 hand-rolled tracer, #1123 item 4). Every
 * test in this file must `vi.resetModules()` and set the env var BEFORE the
 * dynamic `import()` — setting it after import (like most `process.env.*`
 * reads elsewhere in this repo) would not take effect, by design: the whole
 * point is a flag baked in at startup, not re-read per call.
 *
 * `PI_LENS_HOME` is already pointed at a per-worker temp dir by
 * `tests/support/vitest-setup.ts`, so `getGlobalPiLensDir()` (which
 * `debug-handles.log` is written under) is hermetic with no extra setup here.
 */

async function importFresh(enabled: boolean) {
	vi.resetModules();
	if (enabled) {
		process.env.PI_LENS_DEBUG_HANDLES = "1";
	} else {
		delete process.env.PI_LENS_DEBUG_HANDLES;
	}
	return import("../../clients/debug-handles.js");
}

describe("debug-handles: PI_LENS_DEBUG_HANDLES=1 unset (default)", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HANDLES;
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HANDLES;
		else process.env.PI_LENS_DEBUG_HANDLES = originalFlag;
		vi.resetModules();
	});

	it("isDebugHandlesEnabled() is false", async () => {
		const mod = await importFresh(false);
		expect(mod.isDebugHandlesEnabled()).toBe(false);
	});

	it("dumpActiveHandles is a no-op — writes nothing to disk", async () => {
		const mod = await importFresh(false);
		mod.dumpActiveHandles("agent_settled");
		mod.dumpActiveHandles("session_shutdown");
		await mod.flushDebugHandlesLog();
		expect(fs.existsSync(mod.getDebugHandlesLogPath())).toBe(false);
	});

	it("installs no async_hooks tracker — the tracked-resource count stays 0", async () => {
		const mod = await importFresh(false);
		mod._simulateTrackedInitForTest(1, "Timeout");
		expect(mod._trackedResourceCountForTest()).toBe(0);
	});
});

describe("debug-handles: PI_LENS_DEBUG_HANDLES=1 set at startup", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HANDLES;
		fs.rmSync(debugHandlesLogPath(), { force: true });
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HANDLES;
		else process.env.PI_LENS_DEBUG_HANDLES = originalFlag;
		vi.resetModules();
	});

	it("isDebugHandlesEnabled() is true", async () => {
		const mod = await importFresh(true);
		expect(mod.isDebugHandlesEnabled()).toBe(true);
	});

	it("dumpActiveHandles emits one ndjson line with type counts and the given label", async () => {
		const mod = await importFresh(true);
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]);
		expect(entry.label).toBe("agent_settled");
		expect(typeof entry.total).toBe("number");
		expect(typeof entry.counts).toBe("object");
		expect(typeof entry.ts).toBe("string");
	});

	it("dumps at both wired labels independently, appending both lines", async () => {
		const mod = await importFresh(true);
		mod.dumpActiveHandles("agent_settled");
		mod.dumpActiveHandles("session_shutdown");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const labels = raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line).label);
		expect(labels).toEqual(["agent_settled", "session_shutdown"]);
	});

	it("includes creationSites attribution once the tracker has tracked resources", async () => {
		const mod = await importFresh(true);
		mod._simulateTrackedInitForTest(101, "Timeout");
		mod._simulateTrackedInitForTest(102, "Timeout");
		mod._simulateTrackedInitForTest(103, "TCPSOCKETWRAP");
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]);
		expect(Array.isArray(entry.creationSites)).toBe(true);
		const byType = Object.fromEntries(
			(entry.creationSites as { type: string; count: number }[]).map((s) => [
				s.type,
				s.count,
			]),
		);
		expect(byType.Timeout).toBe(2);
		expect(byType.TCPSOCKETWRAP).toBe(1);
	});

	it("the async_hooks tracker map is bounded: a burst past the cap protects the first N entries and reports evictedCount", async () => {
		// #1097-class leaks are typically among the EARLIEST created handles in
		// a session — a naive drop-oldest policy would let a later burst evict
		// exactly that evidence. Assert the protected-earliest policy instead:
		// the first TRACKER_PROTECTED_COUNT ids survive a burst well past the
		// cap, the map still respects TRACKER_MAX_ENTRIES, and every eviction
		// is visible via a running evictedCount rather than a silent drop.
		const mod = await importFresh(true);
		const burstSize = mod.TRACKER_MAX_ENTRIES + 100; // 600 with the current 500 cap
		for (let i = 0; i < burstSize; i++) {
			mod._simulateTrackedInitForTest(i, "Timeout");
		}

		expect(mod._trackedResourceCountForTest()).toBe(mod.TRACKER_MAX_ENTRIES);

		// The protected zone (ids 0..TRACKER_PROTECTED_COUNT-1) must all survive.
		for (let i = 0; i < mod.TRACKER_PROTECTED_COUNT; i++) {
			expect(mod._isTrackedForTest(i)).toBe(true);
		}
		// The most recently created ids must survive too (they're what a live
		// dump cares about right now).
		for (let i = burstSize - 5; i < burstSize; i++) {
			expect(mod._isTrackedForTest(i)).toBe(true);
		}
		// Total evictions: every insert once the map is at cap and outside the
		// protected zone evicts exactly one entry — burstSize - TRACKER_MAX_ENTRIES.
		expect(mod._evictedCountForTest()).toBe(
			burstSize - mod.TRACKER_MAX_ENTRIES,
		);

		// The running evictedCount is surfaced on the dump entry — attribution
		// incompleteness must be an explicit, visible fact.
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();
		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]);
		expect(entry.evictedCount).toBe(burstSize - mod.TRACKER_MAX_ENTRIES);
	});

	it("evictedCount is present (0) on a dump even with no eviction", async () => {
		const mod = await importFresh(true);
		mod._simulateTrackedInitForTest(1, "Timeout");
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]);
		expect(entry.evictedCount).toBe(0);
	});

	it("ignores untracked async_hooks resource types (no unbounded growth from noise)", async () => {
		const mod = await importFresh(true);
		for (let i = 0; i < 20; i++) {
			mod._simulateTrackedInitForTest(i, "PROMISE");
		}
		expect(mod._trackedResourceCountForTest()).toBe(0);
	});

	// P2/P3 follow-up: every test above drives `_simulateTrackedInitForTest`,
	// which exercises the shared cap/eviction logic but never the REAL
	// `async_hooks.createHook` init/destroy plumbing installed by
	// `installHandleTracker()`. This test exercises that plumbing directly
	// against a genuine `setTimeout`.
	//
	// It compares `Timeout`-specific counts from real dumps rather than the
	// tracker's raw total map size, deliberately: polling for the async
	// `destroy` callback needs at least one real macrotask turn, and any real
	// timer/immediate used for that polling is ITSELF a newly tracked
	// resource whose own not-yet-fired `destroy` would otherwise pollute a
	// raw total-size assertion. Reading the `Timeout`-only count from the
	// dump's `creationSites` isolates the resource under test from that
	// necessary polling noise (which shows up under a different type key,
	// e.g. `Immediate`).
	it("a real setTimeout is tracked by the installed async_hooks hook, and pruned on destroy", async () => {
		const mod = await importFresh(true);

		async function timeoutCount(): Promise<number> {
			mod.dumpActiveHandles("agent_settled");
			await mod.flushDebugHandlesLog();
			const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
			const lastLine = raw.split("\n").filter(Boolean).at(-1) as string;
			const entry = JSON.parse(lastLine);
			const byType = Object.fromEntries(
				(entry.creationSites as { type: string; count: number }[]).map((s) => [
					s.type,
					s.count,
				]),
			);
			return byType.Timeout ?? 0;
		}

		const timeoutCountBefore = await timeoutCount();

		const timer = setTimeout(() => {}, 60_000);
		timer.unref();
		// The async_hooks `init` callback fires synchronously during resource
		// creation — the timer is already tracked by the time this returns.
		expect(await timeoutCount()).toBe(timeoutCountBefore + 1);

		clearTimeout(timer);
		// `destroy` fires on a later real event-loop turn — poll with
		// `setImmediate` (an `Immediate`-typed resource, a different key in
		// `byType` than the `Timeout` count under test, so its own transient
		// liveness cannot mask this assertion).
		let lastCount = timeoutCountBefore + 1;
		for (let i = 0; i < 50; i++) {
			lastCount = await timeoutCount();
			if (lastCount === timeoutCountBefore) break;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(lastCount).toBe(timeoutCountBefore);
	});
});
