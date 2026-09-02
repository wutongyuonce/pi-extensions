/**
 * #1276 review (P2) — `DependencyChecker`'s module-level instance registry
 * (`resetMadgeManagedPathMemo()` needs to reach every live checker) used to be
 * a plain `Set<DependencyChecker>`, which strongly retains every instance for
 * the life of the process. Production only ever constructs one (`bootstrap.ts`),
 * but test/reinit instances were never freed — unbounded growth over a long
 * process lifetime (e.g. many short-lived test-suite instances, or a host
 * embedding pi-lens that re-inits per session).
 *
 * The fix holds each instance behind a `WeakRef` instead, pruning dead refs
 * the next time the registry is walked. This file stubs the global `WeakRef`
 * with a controllable fake so "the underlying object was collected" can be
 * simulated deterministically (real GC timing isn't controllable without
 * `--expose-gc`), and proves two things:
 *   1. The registry does NOT hold instances directly — it wraps them, and
 *      `resetMadgeManagedPathMemo()` derefs before acting.
 *   2. A dead ref is pruned from the registry and stops being reset, instead
 *      of being retained/reset forever.
 *
 * Pre-fix, `instances` stores raw `DependencyChecker` objects directly (no
 * `WeakRef` involved), so the fake `WeakRef` this test installs is never
 * constructed — `fakeRefs` stays empty and the assertions below fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRef {
	deref: () => unknown;
	drop: () => void;
}

let fakeRefs: FakeRef[];

beforeEach(() => {
	vi.resetModules();
	fakeRefs = [];
	class FakeWeakRef<T extends object> {
		private value: T | undefined;
		constructor(value: T) {
			this.value = value;
			fakeRefs.push({
				deref: () => this.value,
				drop: () => {
					this.value = undefined;
				},
			});
		}
		deref(): T | undefined {
			return this.value;
		}
	}
	vi.stubGlobal("WeakRef", FakeWeakRef);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DependencyChecker instance registry (#1276 P2)", () => {
	it("wraps instances in WeakRef instead of retaining them directly", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		void new DependencyChecker();

		// Pre-fix: `instances` is `Set<DependencyChecker>` and the constructor
		// never touches `WeakRef` — this stays empty and the test fails here.
		expect(fakeRefs.length).toBe(1);
	});

	it("prunes a collected instance instead of resetting/retaining it forever", async () => {
		const { DependencyChecker, resetMadgeManagedPathMemo } =
			await import("../../clients/dependency-checker.js");

		const checkerA = new DependencyChecker() as unknown as {
			resetMadgeMemo: () => void;
		};
		const checkerB = new DependencyChecker() as unknown as {
			resetMadgeMemo: () => void;
		};
		expect(fakeRefs.length).toBe(2);

		const spyA = vi.spyOn(checkerA, "resetMadgeMemo" as never);
		const spyB = vi.spyOn(checkerB, "resetMadgeMemo" as never);

		resetMadgeManagedPathMemo();
		expect(spyA).toHaveBeenCalledTimes(1);
		expect(spyB).toHaveBeenCalledTimes(1);

		// Simulate checkerA being garbage-collected: its WeakRef now derefs to
		// undefined, exactly like a real collected object would.
		fakeRefs[0].drop();

		resetMadgeManagedPathMemo();
		// The dead ref is skipped (not reset again) and pruned from the
		// registry rather than retained forever.
		expect(spyA).toHaveBeenCalledTimes(1);
		expect(spyB).toHaveBeenCalledTimes(2);

		const registry = (
			DependencyChecker as unknown as { instances: Set<unknown> }
		).instances;
		expect(registry.size).toBe(1);
	});
});
