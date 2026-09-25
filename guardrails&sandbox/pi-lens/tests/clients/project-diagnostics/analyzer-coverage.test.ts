import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYZER_IDS } from "../../../clients/project-diagnostics/fresh-fetch.js";

/**
 * #585 / #1004-class guardrail.
 *
 * Both #585 (opengrep) and #1004 (test-runner) were the SAME bug shape: an
 * analyzer had a real cache writer (session-start's `runHeavyweightTask`
 * wrapper in `runtime-session.ts`, or turn_end's dedicated test-fire in
 * `runtime-turn.ts`) that scanned and cached findings, while
 * `fetchFreshProjectDiagnostics`'s `ANALYZER_IDS` (the single source of truth
 * for `lens_diagnostics mode=full`, #883) silently omitted the id — so the
 * findings were real, cached, and never read back.
 *
 * Rather than hand-maintain a second list of "ids that should be in
 * ANALYZER_IDS" (the exact parallel-list anti-pattern that caused #585 in the
 * first place), this test greps the actual writer call sites in production
 * source and asserts every id found there is a member of `ANALYZER_IDS`. A
 * future analyzer wired into either writer without an `ANALYZER_IDS` entry
 * fails this test instead of silently shipping an orphaned scan-and-cache
 * path.
 */

const repoRoot = path.resolve(__dirname, "../../..");

function readSource(relPath: string): string {
	return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

describe("mode=full analyzer coverage guardrail (#585, #1004)", () => {
	it("every session-start runHeavyweightTask id is a member of ANALYZER_IDS", () => {
		const source = readSource("clients/runtime-session.ts");
		const ids = [...source.matchAll(/runHeavyweightTask\(\s*"([^"]+)"/g)].map(
			(m) => m[1],
		);

		// Sanity check the regex itself still finds something — an empty match
		// list would make the assertion below vacuously true if `runtime-session.ts`
		// ever gets refactored to call the wrapper differently.
		expect(ids.length).toBeGreaterThan(0);

		for (const id of ids) {
			expect(ANALYZER_IDS as readonly string[]).toContain(id);
		}
	});

	// #1004 review follow-up: the original version of this test hardcoded
	// "test-runner-findings" + a single containment check side-by-side — that
	// only catches a REGRESSION of that one id, not a future turn_end writer
	// added without updating this test (the exact generalize-vs-narrow gap
	// flagged in review). Generalized to grep EVERY `cacheManager.writeCache`
	// call in `runtime-turn.ts`, the same way the session-start check above
	// greps `runHeavyweightTask(`, so a new analyzer wired into turn_end is
	// caught structurally instead of depending on someone remembering to touch
	// this file too.
	//
	// Not every turn_end cache write is an analyzer-shaped, mode=full-relevant
	// result, though: `errorDebt`/`turn-end-findings`/`turn-end-findings-last`
	// are turn-end BOOKKEEPING (a one-shot aggregated context-injection message
	// and its dedupe signature, not a distinct analyzer's findings) — there is
	// no runner-adapter for them and there never should be, so they're
	// explicitly excluded rather than silently ignored. Adding a NEW
	// bookkeeping-only cache key means adding it here deliberately; anything
	// else found by the grep must resolve to an `ANALYZER_IDS` member or this
	// test fails — fail-closed, not fail-silent.
	const TURN_END_BOOKKEEPING_KEYS = new Set([
		"errorDebt",
		"turn-end-findings",
		"turn-end-findings-last",
	]);

	// The one place a turn_end cache KEY differs from the `ANALYZER_IDS` id
	// that reads it back (`test-runner-findings` cache key → `test-runner`
	// analyzer id, `runner-adapters/runner-findings.ts`). Every other turn_end
	// analyzer writer (e.g. "knip") already writes under its own ANALYZER_IDS
	// id directly.
	const CACHE_KEY_TO_ANALYZER_ID: Record<string, string> = {
		"test-runner-findings": "test-runner",
	};

	it("every turn_end analyzer-shaped cache writer id is a member of ANALYZER_IDS", () => {
		const source = readSource("clients/runtime-turn.ts");
		const keys = [
			...source.matchAll(/cacheManager\.writeCache\(\s*"([^"]+)"/g),
		].map((m) => m[1]);

		// Sanity check the regex itself still finds something.
		expect(keys.length).toBeGreaterThan(0);

		const analyzerKeys = keys.filter(
			(key) => !TURN_END_BOOKKEEPING_KEYS.has(key),
		);
		// And that at least one non-bookkeeping (analyzer-shaped) key exists —
		// otherwise the exclusion list above could silently swallow everything
		// and this test would pass vacuously.
		expect(analyzerKeys.length).toBeGreaterThan(0);

		for (const key of analyzerKeys) {
			const id = CACHE_KEY_TO_ANALYZER_ID[key] ?? key;
			expect(ANALYZER_IDS as readonly string[]).toContain(id);
		}
	});
});
