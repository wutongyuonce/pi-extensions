/**
 * The caching contract of `createCwdCachedProbe` (#120). Since #1494 the probe
 * returns the SPAWN RESULT rather than a boolean, so the shared availability
 * policy — not this helper — decides what latches. The latch policy itself is
 * covered in `dispatch/runners/cwd-probe-latching.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCwdCachedProbe,
	resetDispatchAvailabilityState,
} from "../../../../../clients/dispatch/runners/utils/runner-helpers.js";

/** A probe that ran and found nothing: a genuine, latching absence. */
const notFound = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	spawnFailure: { kind: "tool-not-found" },
};
const ok = { stdout: "1.0.0", stderr: "", status: 0 };

describe("createCwdCachedProbe (#120)", () => {
	const probeFn = vi.fn();

	beforeEach(() => {
		probeFn.mockReset();
		resetDispatchAvailabilityState();
	});

	it("runs the probe at most once per cwd across repeat callers", async () => {
		probeFn.mockResolvedValue(ok);
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		const a = await probe("/tmp/project-a");
		const b = await probe("/tmp/project-a");
		const c = await probe("/tmp/project-a");
		expect([a, b, c]).toEqual([true, true, true]);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent first-time callers to a single in-flight probe", async () => {
		let resolveProbe: ((value: unknown) => void) | undefined;
		probeFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		const a = probe("/tmp/project-b");
		const b = probe("/tmp/project-b");
		const c = probe("/tmp/project-b");
		expect(probeFn).toHaveBeenCalledTimes(1);
		resolveProbe?.(ok);
		const results = await Promise.all([a, b, c]);
		expect(results).toEqual([true, true, true]);
		// Subsequent call hits the cache directly.
		await probe("/tmp/project-b");
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("scopes the cache per cwd", async () => {
		probeFn.mockResolvedValueOnce(ok).mockResolvedValueOnce(notFound);
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		const a = await probe("/tmp/project-c");
		const b = await probe("/tmp/project-d");
		expect(a).toBe(true);
		expect(b).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(2);
	});

	it("caches a durable absence (no auto-retry — the tool really is missing)", async () => {
		probeFn.mockResolvedValue(notFound);
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(await probe("/tmp/project-e")).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("treats a thrown probe as false and still caches it for the cooldown", async () => {
		probeFn.mockRejectedValue(new Error("probe blew up"));
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		expect(await probe("/tmp/project-f")).toBe(false);
		expect(await probe("/tmp/project-f")).toBe(false);
		expect(probeFn).toHaveBeenCalledTimes(1);
	});

	it("re-probes a stale negative after the session generation resets", async () => {
		probeFn.mockResolvedValueOnce(notFound).mockResolvedValueOnce(ok);
		const probe = createCwdCachedProbe(probeFn, { tool: "widget" });
		expect(await probe("/tmp/project-g")).toBe(false);
		resetDispatchAvailabilityState();
		expect(await probe("/tmp/project-g")).toBe(true);
		expect(probeFn).toHaveBeenCalledTimes(2);
	});
});
