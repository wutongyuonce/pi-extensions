import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_getReverseDepsIndexCacheKeysForTests,
	_seedReverseDepsIndexCacheForTests,
	clearReverseDepsIndexCache,
} from "../../../clients/dispatch/integration.js";

const index = {
	projectRoot: "/workspace",
	generatedAt: "now",
	imports: { "/workspace/a.ts": ["/workspace/b.ts"] },
	importedBy: { "/workspace/b.ts": ["/workspace/a.ts"] },
	source: "review-graph" as const,
};

afterEach(() => {
	clearReverseDepsIndexCache();
	vi.useRealTimers();
	// #2223: the idle-eviction timer test below stubs
	// PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS via vi.stubEnv. Without the
	// unstub, the last stub value ("100000") survives into every later
	// test in this file (refs #2090).
	vi.unstubAllEnvs();
});

describe("reverse-dependency Tier-2 cache bounds (#1389)", () => {
	it("evicts idle roots and permits equivalent recovery", () => {
		vi.useFakeTimers();
		const previous = process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS;
		process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS = "10";
		try {
			_seedReverseDepsIndexCacheForTests("root-a", index, 1);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual(["root-a"]);
			vi.advanceTimersByTime(11);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual([]);
			_seedReverseDepsIndexCacheForTests("root-a", index, 1);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual(["root-a"]);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS;
			else process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS = previous;
		}
	});

	it("keeps one live idle-eviction timer per replacement", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS", "100000");
		const before = vi.getTimerCount();
		for (let i = 0; i < 20; i++)
			_seedReverseDepsIndexCacheForTests("root-a", index, 1);
		expect(vi.getTimerCount() - before).toBe(1);
		vi.useRealTimers();
	});

	it("does not leak PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS to later tests (#2223)", () => {
		expect(process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS).toBeUndefined();
	});
});
