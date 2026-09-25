/**
 * `validate()`'s own top-level catch (#2451; refs #2431).
 *
 * A throw inside `walk()` is a bug in this module, not in the user's config —
 * `MAX_CONFIG_DEPTH` and the cyclic-value guard already keep every ORGANIC
 * input from reaching a stack overflow (#2440), so nothing on disk reaches
 * this catch today. It is a floor, the same way `resolveConfig`'s own catch
 * is: a future bug degrades a document to absent instead of failing a
 * session. The fault is injected at the one seam `walk()` calls before doing
 * anything else with the schema, so the probe asserts what the floor does
 * when it catches, not that a particular input reaches it (same pattern as
 * `tests/clients/config-global-catch.test.ts`'s S-C probe).
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

vi.mock("../../../clients/config-core/schema.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/config-core/schema.js")
		>();
	return {
		...actual,
		schemaType: (schema: unknown) => {
			if (fault.armed) {
				throw new RangeError("internal walk failure: ghp_SECRETSHOULDNOTLEAK");
			}
			return actual.schemaType(schema as never);
		},
	};
});

import { validate } from "../../../clients/config-core/normalize.js";

describe("validate: the internal-throw catch names the error CLASS only (#2451)", () => {
	it("records the class name, never the message, when walk() itself throws", () => {
		fault.armed = true;
		try {
			const result = validate(
				{ a: 1 },
				{ type: "object", properties: {} },
				{
					file: ".pi-lens.json",
				},
			);
			expect(result.value).toBeUndefined();
			expect(result.records).toHaveLength(1);
			const [record] = result.records;
			expect(record.code).toBe("PILENS_CFG_0005");
			expect(record.reason).toContain("RangeError");
			expect(record.reason).toContain("document ignored");
			expect(record.reason).not.toContain("ghp_");
			expect(record.reason).not.toContain("internal walk failure");
		} finally {
			fault.armed = false;
		}
	});
});
