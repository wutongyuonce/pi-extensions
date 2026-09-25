import { describe, expect, it } from "vitest";
import {
	blockCommentInteriorMask,
	detectIndentation,
	hasDetectableIndentation,
	templateLiteralInteriorMask,
} from "../../../clients/dispatch/indent-detect.js";

const T = "\t";

/**
 * The #3039 state-space table, one row per input shape the detector can see.
 * Each row is measured through the real `detectIndentation`; the PR body holds
 * the same table with the master / pre-fix / candidate columns.
 */
const ROWS: Array<{
	id: string;
	content: string;
	expected: { style: string; width: number } | undefined;
}> = [
	{
		id: "R1 2-space file, no comments",
		content:
			"function a() {\n  const x = 1;\n  if (x) {\n    return x;\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R2 4-space file, no comments",
		content:
			"function a() {\n    const x = 1;\n    if (x) {\n        return x;\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039 F1): a top-level JSDoc contributes a run of
		// 1-space ` * ` lines anchored by `/**` at column 0, which certified width
		// 1 on every doc-commented 2- or 4-space file and rewrote it on pass 1.
		id: "R3 2-space file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n */\nfunction add(a, b) {\n  const sum = a + b;\n  if (sum) {\n    return sum;\n  }\n  return 0;\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Same recurrence as R3, 4-space arm (#3039 F1).
		id: "R4 4-space file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n */\nfunction add(a, b) {\n    const sum = a + b;\n    if (sum) {\n        return sum;\n    }\n    return 0;\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// #3039 F1 with a `/*` banner rather than a `/**` doc block: the closing
		// ` */` line is a 1-space line too.
		id: "R5 2-space file with a banner block comment",
		content:
			"/*\n * Copyright 2026 Example.\n * SPDX-License-Identifier: MIT\n */\nexport function main() {\n  run();\n  if (ok) {\n    done();\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R6 tab file, no comments",
		content: `function a() {\n${T}const x = 1;\n${T}if (x) {\n${T}${T}return x;\n${T}}\n}\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		// Recurrence this pins (#3039 F2): a top-level JSDoc has more 1-space
		// continuation lines than the file has tab-indented lines, so the
		// space-majority branch won and a tab file was pinned to spaces.
		id: "R7 tab file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n * @returns the sum\n */\n" +
			`function add(a, b) {\n${T}const sum = a + b;\n${T}if (sum) {\n${T}${T}return sum;\n${T}}\n${T}return 0;\n}\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		// Recurrence this pins (#3038): the shallowest run is continuation
		// alignment, not the formatter's unit, so each format multiplied it.
		id: "R8 aligned continuation run",
		content: "const value = call(\n      first,\n      second,\n    );\n",
		expected: { style: "space", width: 2 },
	},
	{
		// #3038, continuation nested inside a 2-space body.
		id: "R8b aligned continuation inside a 2-space body",
		content:
			"function values() {\n  return [\n      1,\n      2,\n      3,\n  ];\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Recurrence this pins (#3038): a nested-only file cannot distinguish its
		// first run from one indentation unit, so style pinning is declined.
		id: "R9 nested-only ambiguity",
		content: "      nested\n            deeper\n",
		expected: undefined,
	},
	{
		id: "R9b nested-only siblings",
		content: "      nested\n      sibling\n",
		expected: undefined,
	},
	{
		id: "R10 mixed tabs and spaces, space majority",
		content: `top\n  one\n    two\n${T}three\n`,
		expected: { style: "space", width: 2 },
	},
	{
		id: "R10b mixed tabs and spaces, tab majority",
		content: `top\n${T}one\n${T}${T}two\n${T}three\n  four\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		id: "R11 minimum above the plausible-unit cap, nested-only",
		content: "top\n          ten\n                    twenty\n",
		expected: undefined,
	},
	{
		// Recurrence this pins (#3039 F3): without the `minimum <= 8` cap this
		// shape certifies width 10 — a structurally supported but implausible
		// unit — and the formatter re-indents the file ten spaces per level.
		id: "R11b minimum above the cap with a structural boundary",
		content: "function f() {\n          deep();\n}\n",
		expected: undefined,
	},
	{
		// Recurrence this pins (#3039 F3): the `gcd <= 8` arm of the same cap.
		// 20/30 spaces have gcd 10, below the minimum but not a plausible unit.
		id: "R11c gcd above the cap",
		content: `x\n${" ".repeat(20)}a\n${" ".repeat(30)}b\n`,
		expected: undefined,
	},
	{
		id: "R12 single indent level",
		content: "function a() {\n    const x = 1;\n    return x;\n}\n",
		expected: { style: "space", width: 4 },
	},
	{ id: "R13 empty", content: "", expected: { style: "space", width: 2 } },
	{
		id: "R14 whitespace-only",
		content: `\n   \n${T}\n\n`,
		expected: { style: "space", width: 2 },
	},
	{
		// #3161: the raw gate sees the comment continuation, but structural
		// evidence has no indented line. The detector must decline so the caller's
		// skip valve records the refusal instead of pinning the default width.
		id: "R15 block-comment continuations are the only indented lines",
		content:
			"/**\n * A module with no indented code.\n */\nexport const x = 1;\n",
		expected: undefined,
	},
	{
		// #3161 also covers the template mask: its indented text is not a
		// structural formatter signal when no code line carries indentation.
		id: "R15b template-literal interiors are the only indented lines",
		content: "const help = `\n  usage\n`;\nexport const x = 1;\n",
		expected: undefined,
	},
	{
		id: "R16 2-space file with a nested JSDoc",
		content:
			"class A {\n  /**\n   * Does a thing.\n   */\n  run() {\n    go();\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Recurrence this pins (#3039, rejected candidate A): filtering every
		// line matching /^\s*\*/ out of the evidence also eats generator methods
		// and C pointer declarations, which are structural code.
		id: "R17 generator method whose line starts with *",
		content: "class A {\n    *items() {\n        yield 1;\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Same rejected candidate A: prettier formats Markdown, whose bullet
		// markers are structural indentation.
		id: "R18 Markdown bullet list, 2-space nesting",
		content: "# Title\n\n* one\n  * nested\n* two\n  * nested two\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R18b Markdown bullet list, 4-space nesting",
		content: "# Title\n\n* one\n    * nested\n* two\n    * nested two\n",
		expected: { style: "space", width: 4 },
	},
	{
		id: "R19 CSS with a block comment",
		content: "/* palette */\n.a {\n  color: red;\n}\n.b {\n  color: blue;\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R20 Python with indented # comments",
		content:
			"def f():\n    # explain\n    x = 1\n    if x:\n        # nested note\n        return x\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a `/*` inside a string literal must not
		// open a comment region that swallows the rest of the file's evidence.
		// The opener never closes, so its lines stay structural.
		id: "R21 unterminated /* inside a string literal",
		content:
			'const open = "/*";\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n',
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a `/*` that follows `//` on the same line
		// is inside a line comment, not an opener. A later block comment closes,
		// so a false region opened here swallows the file's whole 4-space body
		// instead of being restored as an unterminated opener (R21's path).
		id: "R21b /* inside a line comment, with a later block comment",
		content:
			"// matches /* here\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n/**\n * trailing doc\n */\nexport const x = 1;\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a block comment that opens and closes on
		// one line opens no region. The later block comment supplies the `*/`
		// that a false region would close on.
		id: "R21c one-line block comment, with a later block comment",
		content:
			"/* banner */\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n/**\n * trailing doc\n */\nexport const x = 1;\n",
		expected: { style: "space", width: 4 },
	},
	{
		// The converse of R21b: a `//` that follows the `/*` on the same line is
		// a URL inside the banner, not a line comment, so the banner still opens
		// its region and its ` * ` lines stay out of the evidence.
		id: "R21d multi-line banner whose opener carries a URL",
		content:
			"/* see https://example.com/spec\n * details\n */\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		id: "R22 shell tabs with # comments",
		content: `#!/bin/sh\n# a script\nf() {\n${T}echo hi\n${T}if true; then\n${T}${T}echo deep\n${T}fi\n}\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		// Recurrence this pins (#3059, AGENTS.md defect 49's fourth member): a
		// multi-line template literal's interior is alignment on the string's own
		// content, not a nesting unit — the same shape as a block-comment's ` * `
		// column. Proven through the real FormatService with the pinned biome
		// binary (PR body): a 4-space file carrying this exact template gets
		// rewritten to 2-space on the first pass. Without the exclusion the two
		// 2-space text lines outvote the 4-space code, matching #3039's ` * `
		// mechanism.
		id: "T1 4-space file with a 2-space-indented template literal (help text)",
		content:
			"const HELP = `\n  Usage: tool [options]\n\n  Options:\n    -h, --help     Show this help\n    -v, --version  Show version\n`;\n\nfunction main() {\n    doStuff();\n    if (ok) {\n        run();\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// T1's control: the identical file with the template literal's text
		// flush left, so it donates no indented lines and the file is
		// byte-identical evidence with or without the fix.
		id: "T1-control identical file, template literal flush left",
		content:
			"const HELP = `\nUsage: tool [options]\n\nOptions:\n-h, --help     Show this help\n-v, --version  Show version\n`;\n\nfunction main() {\n    doStuff();\n    if (ok) {\n        run();\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3059 round 2, review F1; AGENTS.md shape 43,
		// "prose mistaken for executable structure"): a JSDoc's own backtick (an
		// inline `` `x` `` or a fenced code sample) has nothing to do with real
		// template literals, but `advanceTemplateState` had no `/* … */` state,
		// so an odd backtick count inside a comment opened a tracked template
		// that stayed open — swallowing the entire real function body from
		// evidence — until a later, unrelated backtick happened to close it. A
		// single stray comment backtick alone would leave that phantom
		// unclosed at EOF, where the opener-never-closes fail-safe absorbs it
		// (see the two-backtick fixtures below in `describe("templateLiteralInteriorMask")`),
		// so this row's trailing `// closes it here \`` comment gives the
		// mutant something to close against instead.
		id: "R1 4-space file with an odd-backtick JSDoc, closed by a later stray backtick",
		content:
			"/**\n * Handles `template literals in strings.\n */\nfunction main() {\n    doStuff();\n    if (ok) {\n        run();\n    }\n}\n// closes it here `\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Same recurrence as R1, tab arm: the JSDoc's stray backtick closes
		// against a backtick inside a LATER string literal instead of a
		// comment, pinning that the `/* … */` state composes with the
		// existing quote-skip the same way it composes with the `//` skip.
		id: "R2 tab file with a JSDoc backtick closed by a later string backtick",
		content:
			`/**\n * Handles \`template literals in strings.\n */\nfunction main() {\n${T}doStuff();\n${T}if (ok) {\n${T}${T}run();\n${T}}\n}\n` +
			'const s = "closes ` here";\n',
		expected: { style: "tab", width: 1 },
	},
];

describe("indentation detection state space (#3038, #3039, #3059)", () => {
	it.each(ROWS.map((row) => [row.id, row] as const))("%s", (_id, row) => {
		expect(detectIndentation(row.content)).toEqual(row.expected);
	});

	it.each([
		["      nested\n", true],
		[`${T}one\n`, true],
		["/**\n * doc\n */\nconst x = 1;\n", true],
		["", false],
		["const x = 1;\n", false],
	] as const)(
		"hasDetectableIndentation reports leading whitespace for %j",
		(content, expected) => {
			expect(hasDetectableIndentation(content)).toBe(expected);
		},
	);
});

// Round 2, F2: blockCommentInteriorMask is a public per-index contract now
// (indent-retarget.ts, #3052, depends on the opener itself being `false`),
// so it gets its own direct assertions instead of only being observed
// indirectly through detectIndentation's aggregated width.
describe("blockCommentInteriorMask", () => {
	it("masks only the interior of a terminated JSDoc, keeping the opener false", () => {
		const lines = ["/**", " * doc", " */", "code();"];
		expect(blockCommentInteriorMask(lines)).toEqual([false, true, true, false]);
	});

	it("keeps every line structural when the opener never closes (R21 shape)", () => {
		const lines = ['const s = "/*";', "function f() {", "  go();", "}"];
		expect(blockCommentInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});

	it("does not open a region for a /* that follows // on the same line (R21b shape)", () => {
		const lines = ["// matches /* here", "function f() {", "  go();", "}"];
		expect(blockCommentInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});

	it("opens a region for a banner whose opener line carries a URL // after /* (R21d shape)", () => {
		const lines = [
			"/* see https://example.com/spec",
			" * details",
			" */",
			"function f() {",
		];
		expect(blockCommentInteriorMask(lines)).toEqual([false, true, true, false]);
	});
});

/**
 * templateLiteralInteriorMask state space (#3059, AGENTS.md defect 49's
 * fourth member). Six axes, mirroring blockCommentInteriorMask's own direct
 * assertions:
 *
 *   position     — opener line / interior line / closer line / outside
 *   ${ } nesting — none / one level (object literal) / a nested template
 *   escaping     — plain backtick / escaped backtick (`\``)
 *   false opener — a backtick inside a `//` comment, a `/* … *\/` comment, or
 *                  a quoted string (round 2, review F1: the lexer originally
 *                  had no `/* … *\/` state, so a JSDoc's own backtick opened
 *                  a tracked template — AGENTS.md shape 43, "prose mistaken
 *                  for executable structure")
 *   escaped-quote — a string's own `\"` must not expose a backtick after it
 *                  (round 2, review F4/M9)
 *   fail-safe reset origin — the opener-never-closes reset starts at
 *                  `openLine + 1`, not always `0` (round 2, review F4/M7)
 *
 * | test                                   | position        | nesting  | escape | false opener | escaped-quote | reset origin |
 * |-----------------------------------------|-----------------|----------|--------|--------------|---------------|--------------|
 * | masks interior, keeps opener/closer     | all four        | none     | no     | no           | no            | n/a          |
 * | ${ } with an object literal survives    | all four        | one level| no     | no           | no            | n/a          |
 * | an escaped backtick does not close early| interior         | none     | yes    | no           | no            | n/a          |
 * | // comment backtick does not open       | n/a (no template)| n/a      | no     | // comment   | no            | n/a          |
 * | /* … *\/ comment backtick does not open | n/a (no template)| n/a      | no     | block comment | no           | n/a          |
 * | string backtick does not open           | n/a (no template)| n/a      | no     | quoted string| no            | n/a          |
 * | escaped quote does not expose a backtick| n/a (no template)| n/a      | no     | quoted string| yes           | n/a          |
 * | unterminated template swallows nothing  | interior (never closes) | none | no | no      | no            | 0 (whole file) |
 * | fail-safe resets only past a real reopen| interior (first, closed) + interior (second, never closes) | none | no | no | no | first close point |
 */
describe("templateLiteralInteriorMask", () => {
	it("masks only the interior of a multi-line template, keeping the opener and closer's own line true and real code false", () => {
		const lines = ["const s = `", "  text", "`;", "code();"];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			false,
		]);
	});

	it("tracks ${ } nesting depth so an object literal inside a substitution does not close it early (#3059 acceptance: nesting stated and tested)", () => {
		// A mutation that stops counting nested `{` inside the substitution (so
		// any `}` pops it) sends this exact input's mask to
		// [false, true, false, false, true, false] instead — see the PR body's
		// mutation transcript.
		const lines = ["const s = `", "${ {} `", "  more", "` }", "`;", "code();"];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			true,
			true,
			false,
		]);
	});

	it("does not close the template on an escaped backtick (#3059 acceptance: escaping stated and tested)", () => {
		const lines = [
			"const s = `",
			"  esc \\` still inside",
			"  more text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			true,
			false,
		]);
	});

	it("does not open a template for a backtick inside a // comment (#3059 acceptance)", () => {
		// A second stray backtick in a later comment is deliberate: a mutation
		// that stops skipping `//` opens a phantom template on line 0 that stays
		// unclosed through the real function body and only closes on line 4,
		// wrongly masking lines 1-4. A single stray backtick alone would leave
		// that phantom open at EOF, where the opener-never-closes fail-safe
		// (below) would unmask it again and hide the mutation.
		const lines = [
			"// a stray ` backtick",
			"function f() {",
			"  go();",
			"}",
			"// closes it here `",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("does not open a template for a backtick inside a string literal (#3059 acceptance)", () => {
		// Same reasoning as the // comment case above: a second string with a
		// stray backtick gives a mutated quote-skip something to (wrongly)
		// close against, so the phantom template's mask survives the
		// opener-never-closes fail-safe instead of being absorbed by it.
		const lines = [
			'const s = "a ` stray backtick";',
			"function f() {",
			"  go();",
			"}",
			'const t = "closes ` here";',
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("keeps every line structural when the opener never closes, mirroring blockCommentInteriorMask's R21 shape", () => {
		const lines = ["const open = `", "function f() {", "    go();", "}"];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});

	it("does not open a template for a backtick inside a /* … */ comment (#3059 round 2, review F1)", () => {
		// A JSDoc's own backtick (an inline `x` or a fenced code sample) has
		// nothing to do with real template literals. Before this row's fix,
		// `advanceTemplateState` had no block-comment state, so this odd
		// backtick opened a tracked template that stayed open through the
		// entire real function body and only closed on the trailing
		// comment's backtick, wrongly masking lines 3-6. The comment's own
		// interior (lines 1-2) is also false here: a lone `"block"` frame is
		// not "live" (hasLiveFrame), so templateLiteralInteriorMask defers
		// that exclusion entirely to blockCommentInteriorMask rather than
		// reporting it too.
		const lines = [
			"/**",
			" * Handles `template literals.",
			" */",
			"function f() {",
			"  go();",
			"}",
			"// closes it here `",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("does not expose a backtick after a string's own escaped quote (#3059 round 2, review F4/M9)", () => {
		// If `skipQuoted` did not honor `\"`, it would treat the escaped quote
		// as the string's real terminator and return early, leaving `b\`c";`
		// exposed to top-level scanning — where the backtick would wrongly
		// open a template that stays open through the real function body,
		// closing only on the trailing comment's backtick (same shape as the
		// block-comment case above, from a different false-opener source).
		const lines = [
			'const s = "a\\"b`c";',
			"function f() {",
			"  go();",
			"}",
			"// closes it here `",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("resets the fail-safe only past the still-open template's own opener, not the whole file (#3059 round 2, review F4/M7)", () => {
		// A first template opens and closes cleanly (lines 0-2, correctly
		// masked); real code follows (line 3); a second, unrelated template
		// then opens and never closes by EOF. The opener-never-closes
		// fail-safe must reset only from the SECOND opener onward (line 4+),
		// leaving the first template's already-correct masking (lines 1-2)
		// alone. A mutation that resets from index 0 instead of `openLine + 1`
		// would also erase the first template's masking.
		const lines = [
			"const a = `",
			"  text",
			"`;",
			"code();",
			"const open = `",
			"more code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			false,
			false,
			false,
		]);
	});

	it("pops the block frame at its own */ close, so a self-closing comment before a real template does not swallow it (#3120, #3118 round-2 verify, E9)", () => {
		// A mutation that stops the block-comment branch from popping its frame
		// once it hits `*/` (so `stack` keeps the "block" frame forever) leaves
		// `hasLiveFrame` false for the rest of the file — a live "block" frame
		// alone is not template evidence, and it also swallows the real
		// template's opening backtick without ever pushing a "template" frame,
		// so lines 2-3 wrongly read as [false, false] instead of [true, true].
		const lines = ["/* banner */", "const s = `", "  text", "`;", "code();"];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			true,
			true,
			false,
		]);
	});

	it("checks the live template frame before the block-comment opener, so a /* inside template text stays plain content (#3120, #3118 round-2 verify, E2)", () => {
		// A mutation that hoists the `/*` block-opener push above the
		// `top?.kind === "template"` branch fires it unconditionally, even
		// while a template frame is already open — pushing a spurious "block"
		// frame on top mid-template. That frame then swallows the template's
		// own closing backtick on line 3 (the block branch never looks for
		// backticks), so the template frame is still live at EOF and the
		// opener-never-closes fail-safe resets every line after the opener to
		// false, instead of masking lines 1-3 as template interior.
		const lines = [
			"const s = `",
			"  /* not a comment",
			"  more",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			true,
			false,
		]);
	});

	it("does not open a phantom template for a backtick inside an unambiguous regex literal (#3120 R3, two regexes with backticks)", () => {
		// Before the regex-literal state: `/`/g`'s backtick (after `=`, an
		// unambiguous opener position) reads as a real template opener, so the
		// real function body between the two regex literals is wrongly
		// swallowed as "template interior" (excluded from indentation
		// evidence) -- an even count of stray backticks closes the phantom
		// pair cleanly, so the opener-never-closes fail-safe never trips and
		// the corruption is silent. With the regex state, both `/`/g`
		// literals are recognised and skipped whole, so their backticks never
		// reach the template branch at all. The trailing `g` flag on both
		// (round 3, F1) pins the flag-skip loop in `skipRegexLiteral`: a
		// mutation that disables it (`while (false)` instead of consuming
		// flag letters) checks the character right after the closing `/` --
		// `g`, an identifier character -- and wrongly rejects this as not a
		// regex literal at all, letting both backticks fall through to the
		// same phantom-template corruption this test exists to catch.
		const lines = [
			"const a = /`/g;",
			"function f() {",
			"  go();",
			"}",
			"const b = /`/g;",
			"const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
			true,
			false,
		]);
	});

	it("does not open a phantom block frame for a /* inside a regex character class (#3120, #3118 round-2 verify addendum 1, /[/*]/ case)", () => {
		// Before the regex-literal state: the `/*` inside `/[/*]/` (a regex
		// matching a literal `/` or `*`) reads as a block-comment opener that
		// never finds a `*/` to close against, so it pushes a "block" frame
		// that stays on the stack for the rest of the file. hasLiveFrame
		// treats a lone "block" frame as not template evidence, so the real
		// template two lines later is never masked at all -- under-masking,
		// degrading to pre-#3059 behaviour. With the regex state, the whole
		// `/[/*]/` literal (including its embedded `/*`) is skipped as one
		// unit and never reaches the block-comment branch.
		const lines = [
			"const re = /[/*]/;",
			"const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			true,
			true,
			false,
		]);
	});

	it("leaves a genuine division expression alone: the unambiguous-position gate does not fire after an identifier or a digit (#3120)", () => {
		// The regex-opener gate only fires in unambiguous positions (after
		// `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, a
		// return/typeof/case keyword, or line start). The `/` right after `10`
		// (a digit -- real division) must stay ungated: a mutation that fires
		// the gate unconditionally instead treats that `/` as a regex opener
		// and walks forward for the next unescaped `/`, which it finds inside
		// "text/ more" -- consuming the real opening backtick along the way
		// without ever pushing a "template" frame. The backtick that was meant
		// to CLOSE that real template is then seen fresh on line 0 and opens a
		// phantom template instead, which line 2's stray backtick closes
		// cleanly -- giving the phantom frame something to close against so
		// the opener-never-closes fail-safe does not erase the difference (the
		// same two-backtick shape the #3059 tests above use). Correct (gated)
		// code never opens any frame here, so every line stays false; the
		// mutation wrongly masks lines 1-2 as template interior.
		const lines = [
			"const n = 10 / `text/ more`; code();",
			"next();",
			"closes_here`;",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([false, false, false]);
	});

	it("recognises a regex opener at line start (#3120, position gate)", () => {
		// Mirrors the R3 shape above (two backtick-bearing regexes bracketing
		// real code), but both `/`/`  literals sit at the START of their own
		// line rather than after `=`, pinning the position gate's line-start
		// branch specifically. A mutation that drops that branch (falling
		// through to the keyword/punctuation checks, both of which miss an
		// empty "before") ungates both openers, so the real function body
		// between them is wrongly swallowed as template interior again.
		const lines = [
			"/`/;",
			"function f() {",
			"  go();",
			"}",
			"/`/;",
			"const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
			true,
			false,
		]);
	});

	it("recognises a regex opener after a return/typeof/case keyword (#3120, position gate)", () => {
		// Same R3 shape again, gated by the `return` keyword branch instead of
		// `=` or line start. A mutation that drops the keyword check ungates
		// both `return /`/;` occurrences, wrongly swallowing the code between
		// them as template interior.
		const lines = [
			"function f() { return /`/; }",
			"  more();",
			"return /`/;",
			"const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			true,
			true,
			false,
		]);
	});

	it("honours a `[...]` character class while scanning for the regex's own closing / (#3120)", () => {
		// The regex `/[/]middle/` has a `/` INSIDE its character class, which
		// must not count as the closing delimiter. A mutation that stops
		// tracking character-class state treats that inner `/` as the close,
		// prematurely ending the scan three characters in; the backtick that
		// was meant to stay inert inside the regex body is then read fresh at
		// the top level, opening then immediately re-closing a phantom
		// template against the line's real opening backtick -- so the real,
		// genuinely unclosed template on this line never gets a frame pushed
		// at all, and the following lines are wrongly left unmasked.
		const lines = [
			"const re = /[/]`middle/; const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			false,
		]);
	});

	it("honours a `\\` escape while scanning for the regex's own closing / (#3120)", () => {
		// The regex `/a\/b/` has an escaped `/` that must not count as the
		// closing delimiter either. A mutation that stops skipping the
		// character after `\\` treats the escaped `/` as the close, exposing
		// the regex body's own backtick to top-level scanning the same way
		// the character-class case above does -- the real template on this
		// line never gets a frame pushed, and the following lines are wrongly
		// left unmasked.
		const lines = [
			"const re = /a\\/b`middle/; const s = `",
			"  text",
			"`;",
			"code();",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			false,
		]);
	});

	it("leaves `/` alone when no closing / is found before EOL, instead of consuming the rest of the line (#3120, fallback safety)", () => {
		// `return /oops` (the gate fires on `return`) never finds a second `/`
		// on this line, so it is not actually a regex literal here -- the
		// fallback must leave `/` as an ordinary character so the line's real
		// opening backtick is still found by normal scanning. A mutation that
		// forces a skip to EOL regardless (ignoring the -1 "not found" result)
		// swallows that backtick along with the rest of the line, so the real
		// template never gets a frame pushed and the following lines are
		// wrongly left unmasked.
		const lines = ["return /oops`text", "  text", "`;", "code();"];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			true,
			true,
			false,
		]);
	});

	it("does not treat `}` as a regex-opener position: a division right after an object literal stays division (#3120 round 2, S3)", () => {
		// `}` was tried in the position gate and dropped: `x = {a:1} / 2` is
		// division in real JS grammar, never a regex opener, and measurement
		// (PR body) showed zero verdict differences from including it anyway --
		// so its exclusion is grammatical soundness, not just an unused entry.
		// A mutation that adds `}` back to REGEX_OPENER_PUNCTUATION treats the
		// `/` right after `{a:1}` as an opener, walks forward for the next
		// unescaped `/` (found inside "text/ more"), and swallows this line's
		// real opening backtick along the way -- the same corruption shape as
		// the division-gate test above, gated through `}` instead of a digit.
		const lines = [
			"const x = {a:1} / `text/ more`; code();",
			"next();",
			"closes_here`;",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([false, false, false]);
	});

	it("rejects a regex-shaped close whose flags are immediately followed by an identifier character (#3120 round 3, F2: identifier-terminator sub-shape)", () => {
		// Round 2 review finding: the position gate fires on every `/` at an
		// unambiguous position, including plain prose -- `Layout: /src ...`
		// gates on the `:` before `/src` the same way real code would. Without
		// this check, the scan for the next unescaped `/` finds the one inside
		// the backticked `` `bin/cli` `` and accepts it as the literal's close,
		// swallowing that backtick; the second backtick (after "cli") then
		// opens a phantom template that stays live through the whole following
		// 2-space bullet list, excluding it from indentation evidence and
		// leaving only the trailing 4-space function body -- detectIndentation
		// returns space/4 instead of the file's real space/2. A regex literal's
		// flags must be followed by a statement boundary, never more identifier
		// text, so requiring a non-identifier character (or EOL) after any
		// flag letters rejects this false close and falls back to ordinary
		// scanning, which finds the real backtick as its own opener instead.
		//
		// This pins ONE sub-shape only, named precisely because it is not the
		// whole defect: round 3 F2 found the false close's next character can
		// also be a NON-identifier (a backtick, space, `)`, `.`) and still
		// swallow a real backtick undetected by this check -- see
		// `skipRegexLiteral`'s doc comment for the measured, documented,
		// deliberately-unfixed residual (closing it needs rejecting any
		// consumed span with an odd backtick count, which is the shape this
		// whole PR exists to recognise as a regex, not reject).
		const lines = [
			"Layout: /src `bin/cli` and friends.",
			"",
			"  - one",
			"  - two",
			"    - nested",
			"",
			"closes it here `",
			"function f() {",
			"    go();",
			"}",
		];
		expect(templateLiteralInteriorMask(lines)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(detectIndentation(`${lines.join("\n")}\n`)).toEqual({
			style: "space",
			width: 2,
		});
	});
});
