/**
 * `resolveConfig()`'s own top-level catch (#2451; refs #2440 review, #2426).
 *
 * `validate()` and `merge()` are BOTH independently bounded (#2440), so no
 * organic input reaches this catch today — it is a floor under a future bug
 * in either half, exactly like `tests/clients/config-global-catch.test.ts`'s
 * S-C probe is for `lens-config.ts`'s own whole-resolution catch. The fault
 * is injected at `merge()`, the seam `resolveConfig` calls after `validate()`
 * has already succeeded, so the probe asserts what the floor does when it
 * catches, not that a particular input reaches it.
 *
 * #2451 folded this catch's error-naming from an inline
 * `error instanceof Error ? error.name : "unknown error"` onto the ONE
 * shared implementation, `clients/error-class.ts`'s `errorClassName` — NOT
 * `config-warn.ts`'s `normalizeParseErrorReason`, which this "pure" module
 * must not import (that re-opens the sink-import cycle #2426 removed from
 * `config-core/`). This file is the regression guard that the fold kept the
 * class-only behavior byte-for-byte.
 */
import { describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ armed: false }));

vi.mock("../../../clients/config-core/merge.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/config-core/merge.js")
		>();
	return {
		...actual,
		merge: (...args: Parameters<typeof actual.merge>) => {
			// One-shot: `resolveConfig`'s own catch calls `merge([], schema)` again
			// to build the empty fallback resolution it returns, and that second
			// call must succeed or the fixture throws somewhere no test code can
			// catch it.
			if (fault.armed) {
				fault.armed = false;
				throw new RangeError("internal merge failure: ghp_SECRETSHOULDNOTLEAK");
			}
			return actual.merge(...args);
		},
	};
});

import { resolveConfig } from "../../../clients/config-core/resolve.js";

describe("resolveConfig: the internal-throw catch names the error CLASS only (#2451)", () => {
	it("records the class name, never the message, when merge() itself throws", () => {
		fault.armed = true;
		try {
			const resolution = resolveConfig({
				schema: { type: "object", properties: {} },
				sources: [{ tier: "global", file: "g.json", value: { a: 1 } }],
			});
			// `merge([], schema)`, the empty resolution the catch falls back to.
			expect(resolution.resolved.value).toBeUndefined();
			const failures = resolution.records.filter(
				(record) => record.code === "PILENS_CFG_0008",
			);
			expect(failures).toHaveLength(1);
			expect(failures[0]?.reason).toContain("RangeError");
			expect(failures[0]?.reason).toContain("configuration ignored");
			expect(failures[0]?.reason).not.toContain("ghp_");
			expect(failures[0]?.reason).not.toContain("internal merge failure");
			expect(failures[0]?.file).toBe("g.json");
		} finally {
			fault.armed = false;
		}
	});
});
