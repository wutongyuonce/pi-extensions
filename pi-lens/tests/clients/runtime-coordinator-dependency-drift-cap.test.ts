/**
 * Direct unit coverage for `RuntimeCoordinator`'s #1950 delivery-cap methods
 * (`peekInlineBlockerStaleDeliveryCount`, `incrementInlineBlockerStaleDelivery`,
 * `retireDemotedDependencyDriftBlocker`).
 *
 * Fix-round F2: adversarial review found `retireDemotedDependencyDriftBlocker`'s
 * own guards (`!existing.stale`, `staleReason !== "dependency-drift"`)
 * unreachable through `runtime-turn.ts`'s only call site, which already
 * pre-filters on `staleReason === "dependency-drift"` before calling. Rather
 * than drop the guards — this is a PUBLIC coordinator method, and a future
 * caller that does not pre-filter would silently retire the wrong record
 * without them — this file exercises them directly, the same way
 * `retireDemotedPastEofBlocker`'s own guards are proven through its
 * `staleReason` argument at the turn-end integration layer
 * (`blocker-past-eof-turn-end.test.ts`'s "does not fight a blocker already
 * demoted by the dependency-drift gate" case).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("RuntimeCoordinator dependency-drift delivery-cap methods (#1950)", () => {
	it("peek and increment are independent: peek never mutates, increment always advances by one", () => {
		const env = setupTestEnvironment("pi-lens-1950-peek-");
		try {
			const runtime = new RuntimeCoordinator();
			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.recordInlineBlockers(target, "🔴 a blocker", 1, ["lsp"]);
			runtime.markInlineBlockerStale(target, "dependency-drift");

			expect(runtime.peekInlineBlockerStaleDeliveryCount(target)).toBe(0);
			// Repeated peeks must not advance the count.
			expect(runtime.peekInlineBlockerStaleDeliveryCount(target)).toBe(0);

			expect(runtime.incrementInlineBlockerStaleDelivery(target)).toBe(1);
			expect(runtime.peekInlineBlockerStaleDeliveryCount(target)).toBe(1);
			expect(runtime.incrementInlineBlockerStaleDelivery(target)).toBe(2);
			expect(runtime.peekInlineBlockerStaleDeliveryCount(target)).toBe(2);
		} finally {
			env.cleanup();
		}
	});

	it("peek and increment return 0 for a file with no recorded blocker", () => {
		const env = setupTestEnvironment("pi-lens-1950-missing-");
		try {
			const runtime = new RuntimeCoordinator();
			const target = path.join(env.tmpDir, "never-recorded.ts");
			expect(runtime.peekInlineBlockerStaleDeliveryCount(target)).toBe(0);
			expect(runtime.incrementInlineBlockerStaleDelivery(target)).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("retireDemotedDependencyDriftBlocker refuses a record that is not stale", () => {
		const env = setupTestEnvironment("pi-lens-1950-notstale-");
		try {
			const runtime = new RuntimeCoordinator();
			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.recordInlineBlockers(target, "🔴 a blocker", 1, ["lsp"]);
			// Never demoted — `stale` is falsy.

			expect(runtime.retireDemotedDependencyDriftBlocker(target)).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("retireDemotedDependencyDriftBlocker refuses a past-EOF demotion on the same file", () => {
		const env = setupTestEnvironment("pi-lens-1950-wrongreason-");
		try {
			const runtime = new RuntimeCoordinator();
			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.recordInlineBlockers(target, "🔴 a blocker", 1, ["lsp"]);
			runtime.markInlineBlockerStale(target, "past-eof");

			// Must not retire a demotion that belongs to the OTHER gate — that
			// gate's own retirement (`retireDemotedPastEofBlocker`) owns it.
			expect(runtime.retireDemotedDependencyDriftBlocker(target)).toBe(false);
			const snapshot = runtime.getInlineBlockersSnapshot();
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.staleReason).toBe("past-eof");
		} finally {
			env.cleanup();
		}
	});

	it("retireDemotedDependencyDriftBlocker retires a genuine dependency-drift demotion", () => {
		const env = setupTestEnvironment("pi-lens-1950-retire-");
		try {
			const runtime = new RuntimeCoordinator();
			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			runtime.recordInlineBlockers(target, "🔴 a blocker", 1, ["lsp"]);
			runtime.markInlineBlockerStale(target, "dependency-drift");

			expect(runtime.retireDemotedDependencyDriftBlocker(target)).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
