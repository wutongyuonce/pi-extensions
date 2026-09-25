import { describe, expect, it } from "vitest";
import { retargetReplacementIndentation } from "../../clients/indent-retarget.js";
import type { IndentRetargetFileContext } from "../../clients/indent-retarget.js";

describe("retargetReplacementIndentation", () => {
	// ── basic remapping ────────────────────────────────────────────────────────

	it("remaps spaces to tabs when oldText and newText share the same nesting depth", () => {
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n    return 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\treturn 2;\n}",
		);
	});

	it("remaps tabs to spaces", () => {
		const oldText = "function foo() {\n\treturn 1;\n}";
		const corrected = "function foo() {\n    return 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n    return 2;\n}",
		);
	});

	// ── deeper nesting not present in oldText ──────────────────────────────────

	it("remaps deeper nesting in newText using n × baseUnit extension", () => {
		// oldText only has 1 level (4 spaces); newText adds a nested block (8 spaces).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText =
			"function foo() {\n    if (x > 0) {\n        return x;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n}",
		);
	});

	it("remaps three nesting levels when only one was in oldText", () => {
		const oldText = "class A {\n    method() {}\n}";
		const corrected = "class A {\n\tmethod() {}\n}";
		// newText has 3 levels — none deeper than 1 appeared in oldText
		const newText =
			"class A {\n    method() {\n        if (x) {\n            return 1;\n        }\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"class A {\n\tmethod() {\n\t\tif (x) {\n\t\t\treturn 1;\n\t\t}\n\t}\n}",
		);
	});

	it("handles all levels already present in oldText via direct map", () => {
		// Both "    " and "        " appear in oldText → direct map hits for both.
		const oldText =
			"function foo() {\n    if (cond) {\n        return 1;\n    }\n}";
		const corrected = "function foo() {\n\tif (cond) {\n\t\treturn 1;\n\t}\n}";
		const newText =
			"function foo() {\n    if (cond) {\n        return 2;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (cond) {\n\t\treturn 2;\n\t}\n}",
		);
	});

	// ── abort on unresolvable indentation ─────────────────────────────────────

	it("returns undefined when a newText line has indentation that is not a multiple of the base unit", () => {
		// baseFrom = "    " (4 spaces); newText has a 3-space indent — not a multiple.
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n   if (x) {\n    const x = 2;\n   }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	it("returns undefined and does not partially remap when deeper lines use a different indent style", () => {
		// newText mixes 4-space (remappable) and tab (not in map and not a multiple of 4-space).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    if (x) {\n\t\treturn x;\n    }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	// ── edge cases ─────────────────────────────────────────────────────────────

	it("returns undefined when oldText and correctedOldText have different line counts", () => {
		expect(
			retargetReplacementIndentation("foo\nbar", "foo", "  foo"),
		).toBeUndefined();
	});

	it("returns undefined when there are no indentation differences between oldText and correctedOldText", () => {
		expect(
			retargetReplacementIndentation(
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
			),
		).toBeUndefined();
	});

	it("preserves blank and whitespace-only lines", () => {
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    const x = 1;\n\n    return x;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tconst x = 1;\n\n\treturn x;\n}",
		);
	});

	it("preserves CRLF line endings in the output", () => {
		const oldText = "function foo() {\r\n    return 1;\r\n}";
		const corrected = "function foo() {\r\n\treturn 1;\r\n}";
		const newText = "function foo() {\r\n    return 2;\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\r\n\treturn 2;\r\n}",
		);
	});

	it("returns undefined when no line in newText actually needs changing", () => {
		// newText already uses the corrected indentation — no change should be applied.
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}"; // already tabs
		// resolveIndent("\t"): not in map, not a multiple of "    " → abort → undefined
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});
});

// ── #3052: a block-comment continuation's alignment must not become the ────
// base nesting unit (AGENTS.md defect 49, third member — a shallowest leading
// run can be alignment, not one nesting unit). Each row's oldText/corrected
// pair gives the comment continuation and the code line DIFFERENT correction
// ratios so a base-unit mix-up produces a visibly wrong (not coincidentally
// right) deeper-nesting value.
describe("retargetReplacementIndentation — block-comment interior excluded from the base unit (#3052)", () => {
	it("bases a 4-space file's deeper nesting on the code line, not the JSDoc's 1-space alignment", () => {
		const oldText = "/**\n * doc\n */\nfunction f() {\n    go();\n}";
		// Comment ratio 1->2; code ratio 4->3 (deliberately different so a
		// comment-derived base would silently mis-scale, not coincide).
		const corrected = "/**\n  * doc\n  */\nfunction f() {\n   go();\n}";
		// "b();" nests one level deeper than anything in oldText — its indent
		// must extend from the code's own 4-space unit (4->3), not the
		// comment's 1-space one (1->2).
		const newText = "function g() {\n    a();\n        b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n   a();\n      b();\n}",
		);
	});

	it("bases a 2-space file's deeper nesting on the code line, not the JSDoc's 1-space alignment", () => {
		const oldText = "/**\n * doc\n */\nfunction f() {\n  go();\n}";
		// Comment ratio 1->3; code ratio 2->4.
		const corrected = "/**\n   * doc\n   */\nfunction f() {\n    go();\n}";
		const newText = "function g() {\n  a();\n      b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n    a();\n            b();\n}",
		);
	});

	it("keeps a tab file's deeper nesting in tabs instead of mixing in the comment's space alignment", () => {
		// The model guessed 2-space alignment for the comment continuation and
		// 4-space indentation for the code; the real file uses 1-space comment
		// alignment (typical even in tab files) and tabs for code.
		const oldText = "/**\n  * doc\n  */\nfunction f() {\n    go();\n}";
		const corrected = "/**\n * doc\n */\nfunction f() {\n\tgo();\n}";
		const newText = "function g() {\n    a();\n        b();\n}";
		// Bug shape: baseFrom picked from the comment ("  " -> " ") would put
		// literal SPACES into a tab file. Fixed: baseFrom is the code's own
		// "    " -> "\t" unit, so the deeper line doubles in tabs.
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("does not treat a generator method's leading `*` as a comment opener", () => {
		// Guards against an over-broad exclusion (any line starting with `*`,
		// or containing one at all) swallowing ordinary code — `*items()` has
		// no `/*` anywhere in it. The single-line body is deliberate: with no
		// sibling line at the same depth, excluding `*items()` would empty the
		// map entirely (abort to undefined) instead of merely picking a
		// different base — the sharpest observable signal for this guard.
		const oldText = "class C {\n  *items() { yield 1; }\n}";
		const corrected = "class C {\n\t*items() { yield 1; }\n}";
		const newText = "class D {\n  *values() {\n    yield 2;\n  }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"class D {\n\t*values() {\n\t\tyield 2;\n\t}\n}",
		);
	});

	it("does not treat a C-style pointer dereference's leading `*` as a comment opener", () => {
		const oldText = "void f() {\n  int *p = &x;\n}";
		const corrected = "void f() {\n\tint *p = &x;\n}";
		const newText = "void g() {\n  int *q = &y;\n    int *r = &z;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"void g() {\n\tint *q = &y;\n\t\tint *r = &z;\n}",
		);
	});

	it("keeps lines after an unterminated /* (a comment token inside a string) as structural evidence", () => {
		// The `/*` here is inside a string literal and never closes anywhere in
		// oldText — indent-detect's own rule treats those lines as structural
		// rather than silently swallowing the rest of the file; retarget must
		// match that rule via the same shared lexer.
		const oldText = 'const s = "/*";\nfunction f() {\n  go();\n}';
		const corrected = 'const s = "/*";\nfunction f() {\n\tgo();\n}';
		const newText = "function g() {\n  a();\n    b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("excludes the comment interior under CRLF line endings too", () => {
		const oldText = "/**\r\n * doc\r\n */\r\nfunction f() {\r\n    go();\r\n}";
		const corrected =
			"/**\r\n  * doc\r\n  */\r\nfunction f() {\r\n   go();\r\n}";
		const newText = "function g() {\r\n    a();\r\n        b();\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\r\n   a();\r\n      b();\r\n}",
		);
	});

	// Round 2, F1: a comment-interior indent must still resolve by DIRECT
	// lookup — only its eligibility as the extrapolation BASE unit is
	// revoked. A replacement that reintroduces the same comment indent (here,
	// adding another JSDoc) must still retarget instead of aborting.
	it("still resolves a comment-interior indent by direct lookup when newText reintroduces it (P3)", () => {
		const oldText = "/**\n * doc\n */\nfunction f() {\n    go();\n}";
		const corrected = "/**\n  * doc\n  */\nfunction f() {\n   go();\n}";
		const newText = "/**\n * added doc\n */\nfunction g() {\n    a();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"/**\n  * added doc\n  */\nfunction g() {\n   a();\n}",
		);
	});
});

// ── #3116: a template-literal interior's alignment must not become the ────
// base nesting unit either (AGENTS.md defect 49, fifth member — same shape
// #3052 fixed for block comments, now via templateLiteralInteriorMask,
// #3059). Each row gives the template's interior and the code line DIFFERENT
// correction ratios so a base-unit mix-up produces a visibly wrong (not
// coincidentally right) deeper-nesting value. Premise probe (quoted in the
// PR body): pre-fix, row1's exact input produced 16 literal spaces for
// `b();` (the template's 1-space unit doubled 8 times) instead of the
// code-derived 6.
describe("retargetReplacementIndentation — template-literal interior excluded from the base unit (#3116)", () => {
	it("bases a 4-space file's deeper nesting on the code line, not the template's 1-space alignment", () => {
		const oldText = "const HELP = `\n text\n`;\nfunction f() {\n    go();\n}";
		// Template ratio 1->2; code ratio 4->3 (deliberately different so a
		// template-derived base would silently mis-scale, not coincide).
		const corrected = "const HELP = `\n  text\n`;\nfunction f() {\n   go();\n}";
		// "b();" nests one level deeper than anything in oldText — its indent
		// must extend from the code's own 4-space unit (4->3), not the
		// template's 1-space one (1->2).
		const newText = "function g() {\n    a();\n        b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n   a();\n      b();\n}",
		);
	});

	it("bases a 2-space file's deeper nesting on the code line, not the template's 1-space alignment", () => {
		const oldText = "const HELP = `\n text\n`;\nfunction f() {\n  go();\n}";
		// Template ratio 1->3; code ratio 2->4.
		const corrected =
			"const HELP = `\n   text\n`;\nfunction f() {\n    go();\n}";
		const newText = "function g() {\n  a();\n      b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n    a();\n            b();\n}",
		);
	});

	it("keeps a tab file's deeper nesting in tabs instead of mixing in the template's space alignment", () => {
		// The template's interior line went from 2-space to 1-space alignment;
		// the code went from 4-space to tabs. A template-derived base would put
		// literal SPACES into a tab file.
		const oldText = "const HELP = `\n  text\n`;\nfunction f() {\n    go();\n}";
		const corrected = "const HELP = `\n text\n`;\nfunction f() {\n\tgo();\n}";
		const newText = "function g() {\n    a();\n        b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("does not treat a backtick inside a string literal as a template opener", () => {
		// Guards against an over-broad exclusion (any line with a backtick
		// anywhere) swallowing ordinary code — the decoy backtick here is
		// inside a quoted string, so templateLiteralInteriorMask (and thus
		// retarget) must never open a template region for it.
		//
		// A SECOND decoy on its own line (review round 2, F2) is required for
		// this to actually exercise skipQuoted's own logic: with only one
		// decoy, neutering skipQuoted (exposing the backtick to top-level
		// scanning) opens a phantom template that never finds a closing
		// backtick anywhere in oldText — the opener-never-closes fail-safe
		// then unmasks everything again, so the mutant's WRONG path (skip
		// disabled, fail-safe absorbs it) coincides with the correct path's
		// output and the test stays green either way. The second decoy gives
		// the phantom something to wrongly close against, so the mutant masks
		// "function f() {" / "  go();" as template interior and diverges.
		const oldText =
			'const s = "a ` decoy";\nfunction f() {\n  go();\n}\nconst t = "b ` decoy";';
		const corrected =
			'const s = "a ` decoy";\nfunction f() {\n\tgo();\n}\nconst t = "b ` decoy";';
		const newText = "function g() {\n  a();\n    b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("keeps lines after a template that never closes as structural evidence", () => {
		// The opening backtick here has no matching closer anywhere in oldText —
		// templateLiteralInteriorMask's own fail-safe leaves those lines
		// unmasked (structural) rather than silently swallowing the rest of the
		// file; retarget must match that rule via the same shared lexer.
		const oldText = "const s = `never closes\nfunction f() {\n  go();\n}";
		const corrected = "const s = `never closes\nfunction f() {\n\tgo();\n}";
		const newText = "function g() {\n  a();\n    b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("excludes the template interior under CRLF line endings too", () => {
		const oldText =
			"const HELP = `\r\n text\r\n`;\r\nfunction f() {\r\n    go();\r\n}";
		const corrected =
			"const HELP = `\r\n  text\r\n`;\r\nfunction f() {\r\n   go();\r\n}";
		const newText = "function g() {\r\n    a();\r\n        b();\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\r\n   a();\r\n      b();\r\n}",
		);
	});

	// A template-interior indent must still resolve by DIRECT lookup — only
	// its eligibility as the extrapolation BASE unit is revoked, mirroring
	// #3052's P3 row for comments. A replacement that reintroduces the same
	// template indent (here, another template literal with the same interior
	// alignment) must still retarget instead of aborting.
	it("still resolves a template-interior indent by direct lookup when newText reintroduces it", () => {
		const oldText = "const HELP = `\n text\n`;\nfunction f() {\n    go();\n}";
		const corrected = "const HELP = `\n  text\n`;\nfunction f() {\n   go();\n}";
		const newText =
			"const OTHER = `\n text more\n`;\nfunction g() {\n    a();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"const OTHER = `\n  text more\n`;\nfunction g() {\n   a();\n}",
		);
	});
});

// ── #3116 review round 2, F1/F4: a fragment-only lexer is ambiguous ────────
// wherever the oldText fragment crosses a template-literal BOUNDARY the
// surrounding file would have resolved unambiguously. A lone backtick reads
// as an OPENER when the fragment lacks the real opener that precedes it, and
// as a CLOSER when the fragment lacks the real closer that follows it — so a
// fragment crossing from one template's close into another's open (or
// starting/ending mid-template) can invert which lines are template interior
// versus real code. `fileContext` anchors the lexer to the real file (the
// same line range a caller resolves via `findUniqueMatchLineRange`) so the
// surrounding template boundaries are read correctly. Every row's fixture is
// reproduced directly against retargetReplacementIndentation (not asserted
// from code inspection) before being written here.
describe("retargetReplacementIndentation — fileContext anchors the mask across a template boundary (#3116 review round 2)", () => {
	// F1 probe (a): oldText is a fragment starting at template A's closer and
	// ending at template B's opener — real code ("function f() {" / "go();" /
	// "}") sits entirely between the two. A fragment-only lexer reads A's
	// closer backtick as an OPENER (no matching opener in the fragment) and
	// B's opener backtick as its CLOSER, so it marks the intervening real code
	// as template interior — excluding "go();"'s indent from the base pick
	// entirely (indentMap has only that one entry) and aborting to undefined,
	// where a correct (file-anchored) read resolves the deeper `b();` line
	// from the code's own ratio.
	it("resolves a fragment that crosses from one template's closer into another's opener (F1 probe a)", () => {
		const fileContent =
			"const A = `\n  first\n`;\nfunction f() {\n   go();\n}\nconst B = `\n  second\n`;\n";
		const oldText = "`;\nfunction f() {\n  go();\n}\nconst B = `";
		const corrected = "`;\nfunction f() {\n   go();\n}\nconst B = `";
		const newText = "function g() {\n  a();\n      b();\n}";
		const fileContext: IndentRetargetFileContext = {
			content: fileContent,
			startLine: 3, // fileContent's line 3 ("`;") is oldText's line 1
		};

		// Without fileContext: the fragment-only lexer's inversion excludes
		// the only real base candidate, so the function safely DECLINES
		// (returns undefined) rather than silently mis-scaling — this is the
		// documented fallback, not the defect itself.
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();

		// With fileContext: correctly resolves from the code's own 2->3 ratio.
		expect(
			retargetReplacementIndentation(newText, oldText, corrected, fileContext),
		).toBe("function g() {\n   a();\n         b();\n}");
	});

	// F1 probe (b): same boundary-crossing shape, but this time the fragment
	// also carries a SECOND template's interior line (with its own, shorter,
	// differing-ratio indent). Without file-anchoring, the inversion excludes
	// the real code line ("go();") from eligibility while wrongly leaving the
	// template interior line eligible — so baseFrom becomes the template's
	// OWN ratio (2->3, mis-scaling a deeper newText line to 12 spaces)
	// instead of the code's real ratio (4->2, correctly giving 4 spaces). A
	// WRONG VALUE, not merely a decline — the sharper of the two review-round
	// manifestations.
	it("does not mis-scale from a template's own ratio when a boundary-crossing fragment wrongly excludes the real code line (F1 probe b)", () => {
		const fileContent =
			"const A = `\n   p\n`;\nfunction f() {\n  go();\n}\nconst B = `\n   q\n`;\n";
		const oldText = "`;\nfunction f() {\n    go();\n}\nconst B = `\n  q";
		const corrected = "`;\nfunction f() {\n  go();\n}\nconst B = `\n   q";
		const newText = "function g() {\n    a();\n        b();\n}";
		const fileContext: IndentRetargetFileContext = {
			content: fileContent,
			startLine: 3,
		};

		expect(
			retargetReplacementIndentation(newText, oldText, corrected, fileContext),
		).toBe("function g() {\n  a();\n    b();\n}");
	});

	// F4: the fragment sits entirely INSIDE a template's interior — neither
	// the opener nor the closer is in the fragment at all. A fragment-only
	// lexer never sees a backtick, so it reads these lines as plain code
	// (mask all false) — the ORIGINAL #3116 defect reappearing specifically
	// when the fragment doesn't carry the opener. File-anchoring the lexer
	// over the real file resolves it: the single differing indent is
	// correctly recognized as template alignment and excluded from the base
	// pick, so a deeper `newText` line correctly DECLINES (undefined) rather
	// than being silently mis-scaled by the template's own alignment ratio.
	it("declines rather than mis-scale when the fragment sits entirely inside a template's interior, opener outside the slice (F4)", () => {
		const fileContent =
			"const HELP = `\n  first\n  second\n`;\nfunction f() {\n  go();\n}\n";
		const oldText = "  first\n  second";
		const corrected = "    first\n    second";
		const newText = "    third\n        fourth";
		const fileContext: IndentRetargetFileContext = {
			content: fileContent,
			startLine: 2, // fileContent's line 2 ("  first") is oldText's line 1
		};

		expect(
			retargetReplacementIndentation(newText, oldText, corrected, fileContext),
		).toBeUndefined();
	});
});
