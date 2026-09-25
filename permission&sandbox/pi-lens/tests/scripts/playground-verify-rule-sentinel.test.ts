/**
 * #2208 fix-round finding F2: the 0-match defect this PR fixes (caller's
 * `--code` never reaching the upstream playground's matcher) can recur
 * through upstream schema drift alone. If ast-grep.github.io ever renames
 * `state.source` — the reviewer's probe simulated this by renaming it to
 * `sourceCode` — `buildPlaygroundUrl`'s `source: code` write lands on a
 * field the playground ignores, and the playground falls back to its own
 * hardcoded sample exactly like the original bug. That failure mode is
 * indistinguishable from a legitimate `{ok:true, matches:0}` by match count
 * alone: nothing throws, nothing times out.
 *
 * The scrape expression's `sentinelFound` field is the guard: it checks
 * whether the caller's own first source line actually appears in the
 * rendered page. The playground always echoes its editor's own source into
 * the DOM, so a genuine run's source line is present; a drifted/discarded
 * source's first line is not (the page instead shows the hardcoded default
 * sample, which was picked specifically not to be JSX/console.log-shaped —
 * see the shipped rule fixtures — so it won't accidentally contain an
 * arbitrary test snippet's first line).
 *
 * This test runs `buildScrapeExpr`'s returned expression against a stubbed
 * `document`, so it needs no Chrome or network. It is deliberately at the
 * scrape-expression layer (not `buildPlaygroundUrl`'s payload layer, which
 * `playground-verify-rule-source-payload.test.ts` already covers) because
 * F2 is specifically that a payload-shape check alone cannot catch drift on
 * the *reading* side — the harness could still write a perfectly-formed
 * `source` field into a schema the live upstream page no longer honors.
 *
 * Red-first: reverting `playground-verify-rule.mjs` to the commit before
 * this fix-round (which has no `sentinelFound` field, no
 * `firstNonEmptyLine` export, and `buildScrapeExpr` takes no argument)
 * fails every assertion here — `buildScrapeExpr` is not callable with a
 * sentinel argument and its output object has no `sentinelFound` key.
 */

import { describe, expect, it } from "vitest";
import {
	buildScrapeExpr,
	firstNonEmptyLine,
	initialPollStability,
	trackStableUnmatched,
} from "../../scripts/playground-verify-rule.mjs";

// Evaluate a buildScrapeExpr() expression against a stubbed `document`,
// mirroring what playground-cdp.mjs's `eval` command does inside the real
// page (Runtime.evaluate against `document`). `gutterTexts` stands in for
// the textContent of whatever DOM elements happen to render a bare integer
// (the real scrape has no reliable selector for "this is a gutter line
// number" — see buildScrapeExpr's own comment on that heuristic).
function runScrapeExpr(
	exprSrc: string,
	innerText: string,
	gutterTexts: string[] = [],
	sourceEditorText?: string,
): unknown {
	const fakeDocument = {
		body: { innerText },
		querySelector: (selector: string) =>
			selector === ".playground > .half:first-child .monaco-editor"
				? { textContent: sourceEditorText ?? innerText }
				: null,
		querySelectorAll: () => gutterTexts.map((t) => ({ textContent: t })),
	};
	// eslint-disable-next-line no-new-func -- test-only sandboxed eval of our own generated expression
	const fn = new Function("document", `return ${exprSrc};`);
	return fn(fakeDocument);
}

describe("playground-verify-rule.mjs firstNonEmptyLine (#2208 F2)", () => {
	it("picks the first non-blank line, trimmed", () => {
		expect(firstNonEmptyLine("\n\n  const a = 1;\nconst b = 2;\n")).toBe(
			"const a = 1;",
		);
	});

	it("returns null for all-blank input", () => {
		expect(firstNonEmptyLine("\n  \n\t\n")).toBeNull();
	});
});

describe("playground-verify-rule.mjs buildScrapeExpr sentinel (#2208 F2)", () => {
	const code = "console.log('sentinel-marker-2208');";
	const sentinel = firstNonEmptyLine(code)!;
	const sentinelB64 = Buffer.from(sentinel, "utf8").toString("base64");

	it("reports sentinelFound:true when the caller's source is on the page (genuine match)", () => {
		const expr = buildScrapeExpr(sentinelB64);
		const page = `${sentinel}\nFound 1 match(es).\n1`;
		const result = runScrapeExpr(expr, page) as {
			found: boolean;
			count: number;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.count).toBe(1);
		expect(result.sentinelFound).toBe(true);
	});

	it("reports sentinelFound:true when Monaco renders inter-token spaces as U+00A0 (nbsp)", () => {
		// Confirmed against the live upstream site: Monaco's editor renders
		// the space between two tokens as U+00A0, not U+0020 (a charCode
		// dump around a rendered "const a = 1" line showed codes
		// 99,111,110,115,116,160,97,160,61,160,49 -- 160 is nbsp). A sentinel
		// with regular spaces (what --code actually contains) would never
		// match that rendered text, misreporting a genuine run as schema
		// drift. buildScrapeExpr normalizes nbsp to a regular space before
		// comparing.
		const spacedCode = "const a = 1;";
		const spacedSentinel = firstNonEmptyLine(spacedCode)!;
		const spacedB64 = Buffer.from(spacedSentinel, "utf8").toString("base64");
		const expr = buildScrapeExpr(spacedB64);
		const nbspRenderedPage = `1\nconst a = 1;\nNo match found.`;
		const result = runScrapeExpr(expr, nbspRenderedPage) as {
			sentinelFound: boolean;
		};
		expect(result.sentinelFound).toBe(true);
	});

	it("reports sentinelFound:true when the caller's source is on the page (genuine zero-match)", () => {
		const expr = buildScrapeExpr(sentinelB64);
		const page = `${sentinel}\nNo match found.`;
		const result = runScrapeExpr(expr, page) as {
			found: boolean;
			count: number;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.count).toBe(0);
		expect(result.sentinelFound).toBe(true);
	});

	it("reports sentinelFound:false when the page shows a different source (simulated upstream schema drift)", () => {
		// Simulates the reviewer's probe: the playground's `state.source`
		// field is renamed (e.g. to `sourceCode`), so our `source: code`
		// write is ignored and the playground falls back to its own
		// hardcoded default sample. The page still renders a normal
		// "Found N match(es)" line — that's exactly why match count alone
		// can't catch this.
		const expr = buildScrapeExpr(sentinelB64);
		const defaultSampleText =
			"function tryAstGrep() {\n  console.log('matched in metavar!')\n}\nFound 3 match(es).\n1\n2\n3";
		const result = runScrapeExpr(expr, defaultSampleText) as {
			found: boolean;
			count: number;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.count).toBe(3);
		expect(result.sentinelFound).toBe(false);
	});

	it("ignores a colliding sentinel in the config pane during schema drift", () => {
		// The rule note documents the canonical example, so the config editor
		// can contain the caller's first line while the source editor still
		// shows the playground's default sample. The body-wide lookup was
		// mutation-survivable for this collision and incorrectly returned true.
		const collidingSource = "arr.length && <JSX>";
		const collidingSentinel = Buffer.from(collidingSource, "utf8").toString(
			"base64",
		);
		const expr = buildScrapeExpr(collidingSentinel);
		const configPane = `id: example\nnote: ${collidingSource}`;
		const defaultSource = "function tryAstGrep() {\n  return 0;\n}";
		const result = runScrapeExpr(
			expr,
			`${configPane}\nFound 0 match(es).\n${defaultSource}`,
			[],
			defaultSource,
		) as { found: boolean; count: number; sentinelFound: boolean };
		expect(result.found).toBe(true);
		expect(result.count).toBe(0);
		expect(result.sentinelFound).toBe(false);
	});

	it("only requires the FIRST source line — survives Monaco's viewport virtualization", () => {
		// A real 122-line source has line 1 rendered but not the tail (the
		// editor virtualizes off-screen lines). Simulate that: the page
		// text carries the first line but nothing resembling the rest of a
		// long fixture.
		const longCode = [
			sentinel,
			...Array.from({ length: 200 }, (_, i) => `// padding line ${i}`),
		].join("\n");
		const longSentinel = firstNonEmptyLine(longCode)!;
		const longB64 = Buffer.from(longSentinel, "utf8").toString("base64");
		const expr = buildScrapeExpr(longB64);
		// Only the first line is "rendered" — the rest of the 200 lines are
		// virtualized out, matching the reviewer's observed DOM behavior.
		const virtualizedPage = `${longSentinel}\nFound 0 match(es).`;
		const result = runScrapeExpr(expr, virtualizedPage) as {
			sentinelFound: boolean;
		};
		expect(result.sentinelFound).toBe(true);
	});

	it("treats a null sentinel (no --code) as vacuously satisfied", () => {
		const expr = buildScrapeExpr(null);
		const result = runScrapeExpr(expr, "Found 0 match(es).") as {
			sentinelFound: boolean;
		};
		expect(result.sentinelFound).toBe(true);
	});
});

describe("playground-verify-rule.mjs buildScrapeExpr tab normalization (#2306)", () => {
	// #2306: a first source line with an internal tab
	// (`const\tok\t= arr.indexOf(x) !== -1;`) reported false schema drift —
	// Monaco does not render the tab as a literal U+0009, so a sentinel
	// built from the caller's raw source (with a real tab character) never
	// matched the rendered page. This burned the full poll timeout before
	// concluding "likely upstream schema drift" for what was really a
	// normalization gap in this harness.
	const tabbedCode = "const\tok\t= arr.indexOf(x) !== -1;";
	const tabbedSentinel = firstNonEmptyLine(tabbedCode)!;
	const tabbedB64 = Buffer.from(tabbedSentinel, "utf8").toString("base64");

	it("reports sentinelFound:true when Monaco renders each tab as a run of nbsp", () => {
		// Mirrors the existing nbsp-for-space test above: simulates Monaco
		// expanding a tab into several nbsp glyphs instead of U+0009.
		const nbspRun = "    ";
		const renderedSource = `const${nbspRun}ok${nbspRun}=${nbspRun}arr.indexOf(x)${nbspRun}!==${nbspRun}-1;`;
		const expr = buildScrapeExpr(tabbedB64);
		const page = `${renderedSource}\nNo match found.`;
		const result = runScrapeExpr(expr, page, [], renderedSource) as {
			found: boolean;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.sentinelFound).toBe(true);
	});

	it("reports sentinelFound:true when Monaco renders each tab as a run of regular spaces", () => {
		const spaceRun = "    ";
		const renderedSource = `const${spaceRun}ok${spaceRun}=${spaceRun}arr.indexOf(x)${spaceRun}!==${spaceRun}-1;`;
		const expr = buildScrapeExpr(tabbedB64);
		const page = `${renderedSource}\nFound 1 match(es).\n1`;
		const result = runScrapeExpr(expr, page, [], renderedSource) as {
			found: boolean;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.sentinelFound).toBe(true);
	});

	it("still reports sentinelFound:false when the rendered source is genuinely different (schema drift survives normalization)", () => {
		const expr = buildScrapeExpr(tabbedB64);
		const defaultSampleText =
			"function tryAstGrep() {\n  console.log('matched in metavar!')\n}\nFound 3 match(es).\n1\n2\n3";
		const result = runScrapeExpr(expr, defaultSampleText) as {
			found: boolean;
			sentinelFound: boolean;
		};
		expect(result.found).toBe(true);
		expect(result.sentinelFound).toBe(false);
	});
});

describe("playground-verify-rule.mjs buildScrapeExpr line clamp (#2208 F6)", () => {
	// #2208 fix-round F6: the gutter-number filter used to clamp scraped line
	// numbers to `n <= count` (the MATCH count) instead of the source's own
	// line count. A match on line 3 of a 3-line file, with only 1 total
	// match, reported `lines: [1]` — line 3 was discarded because 3 > the
	// match count of 1, even though 3 is a perfectly valid line number in a
	// 3-line file. `maxLine` (the caller's source line count) is the correct
	// clamp: a gutter number can never legitimately exceed it.
	it("keeps gutter numbers up to the source's line count, not the match count", () => {
		// 3-line source, 1 match, gutter renders line numbers 1-3 (as a real
		// editor's gutter does for every line, not just matched ones).
		const expr = buildScrapeExpr(null, 3);
		const page = "Found 1 match(es).";
		const result = runScrapeExpr(expr, page, ["1", "2", "3"]) as {
			count: number;
			lines: number[];
		};
		expect(result.count).toBe(1);
		// The old `n <= count` clamp would produce [1] here — the actual
		// match-on-line-3 case this finding names. [1, 2, 3] is what
		// clamping to maxLine produces; it's still a best-effort heuristic
		// (see buildScrapeExpr's docs), but it no longer systematically
		// discards valid line numbers above the match count.
		expect(result.lines).toEqual([1, 2, 3]);
	});

	it("still discards numbers that exceed the source's own line count", () => {
		// A stray "99" elsewhere on the page (e.g. a version number, a
		// timestamp) must not be reported as a match line just because it's
		// numeric — maxLine still bounds it.
		const expr = buildScrapeExpr(null, 3);
		const page = "Found 1 match(es).";
		const result = runScrapeExpr(expr, page, ["1", "99"]) as {
			lines: number[];
		};
		expect(result.lines).toEqual([1]);
	});

	it("falls back to no clamp when maxLine is omitted (defensive default)", () => {
		const expr = buildScrapeExpr(null);
		const page = "Found 1 match(es).";
		const result = runScrapeExpr(expr, page, ["1", "50"]) as {
			lines: number[];
		};
		expect(result.lines).toEqual([1, 50]);
	});
});

describe("playground-verify-rule.mjs trackStableUnmatched fail-fast (#2306)", () => {
	// #2306 acceptance criterion 3: a sentinel mismatch should conclude
	// faster than the full poll timeout when the first poll already renders
	// a stable, unmatched pane. trackStableUnmatched is the pure poll-loop
	// decision extracted from main() so this can be proven without a live
	// Chrome/CDP harness.
	it("does not conclude early while the source pane is still mounting (sourceLen changing)", () => {
		let state = initialPollStability;
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 0 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 12 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
	});

	it("concludes early once a non-empty sourceLen repeats for the required consecutive polls", () => {
		let state = initialPollStability;
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		expect(state.concludedEarly).toBe(true);
	});

	it("resets the stability streak when sentinelFound becomes true", () => {
		let state = initialPollStability;
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: false, sourceLen: 34 },
			state,
		);
		state = trackStableUnmatched(
			{ found: true, sentinelFound: true, sourceLen: 34 },
			state,
		);
		expect(state.concludedEarly).toBe(false);
		expect(state.stableUnmatchedPolls).toBe(0);
	});

	it("never counts a zero-length source pane toward the early exit", () => {
		let state = initialPollStability;
		for (let i = 0; i < 10; i++) {
			state = trackStableUnmatched(
				{ found: true, sentinelFound: false, sourceLen: 0 },
				state,
			);
		}
		expect(state.concludedEarly).toBe(false);
	});
});
