import { describe, expect, it } from "vitest";
import type { TouchFileResult } from "../../../clients/lsp/diagnostic-binding.js";

// #1179 / #1108 shape-5 (side-channel copy-loss). `touchFile` returns a WRAPPER
// whose `inconclusive` (#570/#1093) and `binding` (#1095) flags are EXPLICIT
// ENUMERABLE fields — the diagnostics array lives under `.diags`. A copy of the
// diagnostics (`[...]`/`.map`/`.filter`/`JSON`) therefore operates on `.diags` and
// CANNOT drop the flags on the wrapper — the copy-loss class that bit as #1094 /
// #1096 is now impossible by construction. The negative-control test proves the
// copy operations are genuinely lossy for the OLD non-enumerable array carriage,
// so these tests would fail if the flags regressed to that carriage with a copy
// intervening. Pure logic — meaningful on Linux CI (no FS / timing).

const makeResult = (): TouchFileResult => ({
	diags: [
		{
			severity: 1,
			message: "type error",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		} as unknown as TouchFileResult["diags"][number],
	],
	inconclusive: true,
	binding: { boundToCurrentDisk: false },
});

describe("TouchFileResult wrapper — shape-5 copy survival (#1179)", () => {
	it("inconclusive + binding are enumerable OWN fields (survive spread and JSON of the wrapper)", () => {
		const result = makeResult();
		expect(
			Object.prototype.propertyIsEnumerable.call(result, "inconclusive"),
		).toBe(true);
		expect(Object.prototype.propertyIsEnumerable.call(result, "binding")).toBe(
			true,
		);

		const spread = { ...result };
		expect(spread.inconclusive).toBe(true);
		expect(spread.binding?.boundToCurrentDisk).toBe(false);

		const roundTripped = JSON.parse(JSON.stringify(result)) as TouchFileResult;
		expect(roundTripped.inconclusive).toBe(true);
		expect(roundTripped.binding?.boundToCurrentDisk).toBe(false);
	});

	it("copying .diags ([...], .filter, .map, JSON) leaves both flags on the wrapper intact", () => {
		const result = makeResult();

		// The exact copies a consumer performs on the diagnostics array — each used to
		// silently drop a non-enumerable side-channel hung on the array itself.
		const spreadCopy = [...result.diags];
		const filteredCopy = result.diags.filter((d) => d.severity === 1);
		const mappedCopy = result.diags.map((d) => d);
		const jsonCopy = JSON.parse(JSON.stringify(result.diags));
		for (const copy of [spreadCopy, filteredCopy, mappedCopy, jsonCopy]) {
			expect(Array.isArray(copy)).toBe(true);
			expect(copy).toHaveLength(1);
		}

		// After every copy of `.diags`, the flags still ride the wrapper — the read a
		// consumer does off the wrapper (e.g. cascade `readInconclusive`) is unaffected.
		expect(result.inconclusive).toBe(true);
		expect(result.binding?.boundToCurrentDisk).toBe(false);
	});

	it("negative control: a non-enumerable flag on the ARRAY (the pre-#1179 carriage) IS dropped by every copy", () => {
		// The old carriage: a non-enumerable flag hung directly on the diagnostics
		// array. Readable off the ORIGINAL, but any copy drops it — this is exactly
		// the #1094/#1096 loss the wrapper eliminates, and it proves the copies above
		// are genuinely lossy (so the survival assertions are not vacuous).
		const legacy: unknown[] = [];
		Object.defineProperty(legacy, "inconclusive", {
			value: true,
			enumerable: false,
			configurable: true,
		});
		expect((legacy as { inconclusive?: boolean }).inconclusive).toBe(true);

		expect(([...legacy] as { inconclusive?: boolean }).inconclusive).toBe(
			undefined,
		);
		expect(
			(legacy.filter(() => true) as { inconclusive?: boolean }).inconclusive,
		).toBe(undefined);
		expect(
			(legacy.map((d) => d) as { inconclusive?: boolean }).inconclusive,
		).toBe(undefined);
		expect(
			(JSON.parse(JSON.stringify(legacy)) as { inconclusive?: boolean })
				.inconclusive,
		).toBe(undefined);
	});
});
