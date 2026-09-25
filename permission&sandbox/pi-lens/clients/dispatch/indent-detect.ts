type IndentStyle = "tab" | "space";

export interface Indentation {
	style: IndentStyle;
	width: number;
}

const DEFAULT_INDENTATION: Indentation = { style: "space", width: 2 };

/**
 * Infer the prevailing indentation convention from lines that are indented.
 * Formatter callers use it only as a conservative fallback when the repository
 * has no config. It has two pieces of lexical knowledge: the `/* … *\/` block
 * comment and the multi-line template literal, whose interior lines are
 * alignment rather than nesting; everything else is counted as written.
 */
export function detectIndentation(content: string): Indentation | undefined {
	const lines = structuralLines(content.split(/\r?\n/));
	const tabs = lines.filter((line) => /^\t+\S/.test(line)).length;
	const spaceCounts = lines
		.map((line) => line.match(/^ +(?=\S)/)?.[0].length ?? 0)
		.filter((count) => count > 0);

	if (tabs === 0 && spaceCounts.length === 0) {
		// The formatter gate uses the shared hasDetectableIndentation predicate. If
		// that predicate fired but structural masking removed every candidate line,
		// there is no style to pin and the caller must take the #3038 skip valve
		// instead of imposing the default width. Keep the historical default for
		// content with no raw indentation, whose callers never enter this path.
		return hasDetectableIndentation(content) ? undefined : DEFAULT_INDENTATION;
	}
	if (tabs > spaceCounts.length) return { style: "tab", width: 1 };
	if (spaceCounts.length > tabs) {
		const minimum = Math.min(...spaceCounts);
		// 0 is GCD's identity, so seeding the fold both satisfies "reduce needs an
		// initial value" and leaves every result unchanged.
		const gcd = spaceCounts.reduce(
			(unit, count) => greatestCommonDivisor(unit, count),
			0,
		);
		const nonBlank = lines
			.map((line) => line.match(/^( *)\S/)?.[1]?.length)
			.filter((count): count is number => count !== undefined);
		const hasStructuralBoundary = nonBlank.some((count, index) => {
			const previous = nonBlank[index - 1];
			return count === minimum && previous !== undefined && previous < minimum;
		});
		if (hasStructuralBoundary && minimum <= 8) {
			return { style: "space", width: minimum };
		}
		// A continuation line can be the shallowest observed line even though it
		// is not one indentation unit from the surrounding structure. GCD gives
		// those aligned runs their structural unit (for example 4/6 -> 2).
		if (gcd < minimum && gcd <= 8) {
			return { style: "space", width: gcd };
		}
		// A file containing only nested runs (for example 6/12 spaces) has no
		// evidence that its first run is one unit rather than three or six. Do
		// not impose a formatter style on that ambiguous evidence.
		return undefined;
	}

	return DEFAULT_INDENTATION;
}

/**
 * Whether the line opens a block comment that it does not also close. A `/*`
 * that follows a `//` on the same line is inside a line comment, not an
 * opener; a `//` that follows the `/*` (a URL in a banner) is not.
 */
function opensBlockComment(line: string): boolean {
	const blockAt = line.indexOf("/*");
	if (blockAt < 0) return false;
	const lineAt = line.indexOf("//");
	if (lineAt >= 0 && lineAt < blockAt) return false;
	return line.indexOf("*/", blockAt + 2) < 0;
}

/**
 * One boolean per line: true when the line sits *inside* a terminated block
 * comment, so its leading space is alignment on the opener's `*` column, not
 * a nesting unit. The opener line itself is false (its own indentation *is*
 * structural). An opener that never closes was a `/*` inside a string or a
 * regex, so its lines are left false rather than silently swallowed.
 *
 * Shared by {@link structuralLines} (drops the lines from indentation
 * detection's own evidence — a top-level JSDoc otherwise contributes a run
 * of 1-space lines, so a 2- or 4-space file with doc comments reads as width
 * 1 and a tab file with a top-level JSDoc reads as spaces, #3039 F1/F2) and
 * by `clients/indent-retarget.ts`'s `retargetReplacementIndentation`, which
 * must not pick its base nesting unit from a comment's alignment column
 * either (#3052) — one lexer for "which lines carry structure", not two.
 */
export function blockCommentInteriorMask(lines: string[]): boolean[] {
	const mask: boolean[] = Array.from({ length: lines.length }, () => false);
	let pendingStart = -1;
	for (const [i, line] of lines.entries()) {
		if (pendingStart >= 0) {
			mask[i] = true;
			if (line.includes("*/")) pendingStart = -1;
			continue;
		}
		if (opensBlockComment(line)) pendingStart = i;
	}
	if (pendingStart >= 0) {
		for (let i = pendingStart + 1; i < lines.length; i += 1) mask[i] = false;
	}
	return mask;
}

type TemplateFrame =
	| { kind: "template" }
	| { kind: "expr"; braceDepth: number }
	| { kind: "block" };

/** Whether `stack` holds a frame the mask (or its fail-safe) must treat as
 * "inside a template" — every frame except `"block"`. A `/* … *\/` comment
 * nested in the tracked span (plain code, or inside a `${ … }` substitution)
 * is not itself template evidence; {@link blockCommentInteriorMask} already
 * excludes a top-level block comment's own lines. */
function hasLiveFrame(stack: TemplateFrame[]): boolean {
	return stack.some((frame) => frame.kind !== "block");
}

/**
 * Advance a lexical stack over one line of source, mutating it in place.
 * Shared by {@link templateLiteralInteriorMask}'s per-line pass. `stack`
 * empty means plain code; a `"template"` frame means raw template text; an
 * `"expr"` frame means code inside a `${ … }` substitution, with its own
 * brace-depth counter so a nested `{`/`}` (an object literal, a block) does
 * not close the substitution early — only the brace that returns the counter
 * to 0, the one that matches the `${`, does; a `"block"` frame means a
 * `/* … *\/` comment, so a JSDoc's own backtick (a fenced code sample, an
 * inline `` `x` ``) never opens a tracked template that then swallows real
 * code up to whatever later backtick happens to close it (#3059 review F1,
 * AGENTS.md shape 43 — prose mistaken for executable structure).
 *
 * A backtick, `//`, `/*`, or quote character means nothing while `//` has
 * already started a line comment, a `/* … *\/` comment is open, or a quoted
 * string is open, so all three states resolve before the general
 * per-character switch (line comments run to EOL; quoted strings skip
 * everything up to their own unescaped terminator, taking a backtick inside
 * them out of consideration the same way; a block comment skips everything,
 * backticks included, up to its own `*\/`, possibly spanning lines).
 *
 * A regex literal (`` /pattern/flags ``) has its own resolution: the same
 * class of problem as a `/* … *\/` comment or a quoted string, since a
 * backtick or `/*` inside one must not be read as a real opener either
 * (#3120). Disambiguating `/` from division in general needs a real
 * tokenizer with full grammar context — a first-pass heuristic tried here
 * over-declined the corpus 54 files vs 5 for a real fix, so {@link
 * isRegexOpenerPosition} only recognises `/` as an opener in positions
 * where JS grammar makes a value expression, never a divisor: immediately
 * after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, a `return`/`typeof`/
 * `case` keyword, or at line start. (`{`, `}`, and `;` were tried too —
 * dropped, not just unused: `}` is grammatically unsound on its own
 * (`x = {a:1} / 2` is division, not a regex opener, and both sibling
 * lexers in this tree — `tests/support/sweep-kit.ts`,
 * `scripts/check-pr-body.mjs`'s `blankCommentsAndStrings` — exclude it for
 * that reason), and measurement showed `{`/`}`/`;` firing 10/0/6 times
 * across a 25,553-file corpus (own tree plus `node_modules`, every
 * extension biome/prettier/ruff/shfmt format) with zero verdict
 * differences either way — see #3120 PR round 2.) Anywhere else (after an
 * identifier, a digit, `)`, `]`, a string, or a template) is left alone
 * exactly as before this state existed — division stays division, so the
 * gate can only ever add masking correctness, never remove it, MODULO the
 * closing-scan's own correctness (see {@link skipRegexLiteral}'s doc
 * comment: the position gate alone is not sufficient — a misfired skip
 * that swallows an odd number of backticks can still invert parity for
 * the rest of the file; measured against the same corpus, this changed
 * 0 files' verdicts, but 158 of 181 gate firings on the corpus's 882
 * Markdown files alone accepted a false close before the closing-scan's
 * own tightening below cut that to 19). A recognised opener is skipped to its own
 * closing `/` (honouring `[...]` character classes and `\` escapes) by
 * {@link skipRegexLiteral} the same way `skipQuoted` skips a string;
 * everything inside — backticks, `/*`, quotes — is consumed without
 * touching `stack`. A regex literal cannot itself contain a literal
 * newline, so this resolves entirely within one line; the position gate
 * fires on every `/` that starts a line (for instance a Markdown path
 * like `/src`), not only on shapes that can actually close as a regex —
 * it is the closing scan's own `-1` fallback, not the gate, that makes an
 * unclosed or wrongly-shaped match safe.
 */
function advanceTemplateState(line: string, stack: TemplateFrame[]): void {
	let j = 0;
	while (j < line.length) {
		const top = stack[stack.length - 1];
		if (top?.kind === "template") {
			if (line[j] === "\\") {
				j += 2; // an escaped character, including an escaped backtick, \`
				continue;
			}
			if (line.startsWith("${", j)) {
				stack.push({ kind: "expr", braceDepth: 1 });
				j += 2;
				continue;
			}
			if (line[j] === "`") {
				stack.pop();
				j += 1;
				continue;
			}
			j += 1;
			continue;
		}
		if (top?.kind === "block") {
			const closeAt = line.indexOf("*/", j);
			if (closeAt < 0) return; // still inside the comment at EOL
			stack.pop();
			j = closeAt + 2;
			continue;
		}
		// Plain code, at the top level or inside a `${ … }` substitution.
		if (line.startsWith("//", j)) return; // rest of line is a line comment
		if (line.startsWith("/*", j)) {
			stack.push({ kind: "block" });
			j += 2;
			continue;
		}
		if (line[j] === "/" && isRegexOpenerPosition(line, j)) {
			const after = skipRegexLiteral(line, j);
			if (after >= 0) {
				j = after;
				continue;
			}
			// No closing `/` before EOL: not actually a regex literal at this
			// position (the heuristic misfired, or the line just ends mid-token).
			// Fall through and scan `/` as an ordinary character, unchanged from
			// before this state existed.
		}
		const ch = line[j];
		if (ch === '"' || ch === "'") {
			j = skipQuoted(line, j, ch);
			continue;
		}
		if (ch === "`") {
			stack.push({ kind: "template" });
			j += 1;
			continue;
		}
		if (top?.kind === "expr") {
			if (ch === "{") {
				top.braceDepth += 1;
				j += 1;
				continue;
			}
			if (ch === "}") {
				top.braceDepth -= 1;
				j += 1;
				if (top.braceDepth === 0) stack.pop();
				continue;
			}
		}
		j += 1;
	}
}

/** Skip a single- or double-quoted string starting at `quote`, honoring `\`
 * escapes, so a backtick (or anything else) inside it is never inspected. */
function skipQuoted(line: string, start: number, quote: string): number {
	let j = start + 1;
	while (j < line.length) {
		if (line[j] === "\\") {
			j += 2;
			continue;
		}
		if (line[j] === quote) return j + 1;
		j += 1;
	}
	return line.length; // unterminated on this line; nothing more to find
}

/** The set of characters that make a following `/` unambiguous — JS grammar
 * only accepts a value expression there, never a divisor. */
const REGEX_OPENER_PUNCTUATION = new Set([
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
]);

/** A `return`, `typeof`, or `case` keyword, word-bounded, immediately before
 * (modulo trailing whitespace) the position under test. */
const REGEX_OPENER_KEYWORD = /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case)$/;

/**
 * Whether `line[at]` (a `/`) sits in a position where JS grammar makes it a
 * regex-literal opener rather than division: immediately after one of
 * {@link REGEX_OPENER_PUNCTUATION}, a `return`/`typeof`/`case` keyword, or
 * at the start of the line (#3120). Deliberately narrower than every legal
 * regex position (an arrow function's `=>`, for instance, is not
 * recognised) — a missed opener leaves `/` division-shaped exactly like
 * before this state existed, so under-recognition is inert while
 * over-recognition would corrupt real code.
 */
function isRegexOpenerPosition(line: string, at: number): boolean {
	const before = line.slice(0, at).replace(/[ \t]+$/, "");
	if (before === "") return true; // line start (modulo leading whitespace)
	if (REGEX_OPENER_KEYWORD.test(before)) return true;
	return REGEX_OPENER_PUNCTUATION.has(before.at(-1) ?? "");
}

/** Regex flag letters JS accepts after a literal's closing `/`. */
const REGEX_FLAG_CHARS = "dgimsuvy";

/**
 * Skip a regex literal starting at its opening `/` (`start`), honoring
 * `[...]` character classes (a `/` or unescaped `]` inside one closes
 * nothing) and `\` escapes, mirroring {@link skipQuoted}. Returns the index
 * just past the closing `/`, or -1 if none is found before EOL — a regex
 * literal cannot contain a literal newline, so an unclosed scan means this
 * was not actually one.
 *
 * The position gate ({@link isRegexOpenerPosition}) alone is not enough:
 * it fires on every `/` that starts a value-expression position, including
 * prose that merely looks like one — a Markdown line like `` Layout: /src
 * `bin/cli` and friends. `` gates on the `:` before `/src`, and the first
 * `/` found afterward (inside the backticked `` `bin/cli` ``) would
 * otherwise read as a valid close, swallowing the backtick and inverting
 * template-tracking parity for the rest of the file. A closing `/` is
 * accepted only when it is followed by zero or more regex flag letters
 * ({@link REGEX_FLAG_CHARS}) and then a NON-IDENTIFIER character (or
 * EOL) — `/src/cli` and friends` has an identifier character (`c`) right
 * after the candidate close, which a real regex literal's own syntax
 * forbids (flags must be immediately followed by a statement terminator,
 * not more identifier text), so it is rejected and the scan returns -1
 * instead.
 *
 * This narrows the false-close family, it does not close it: when what
 * follows the false close is instead a NON-identifier character (a
 * backtick, a space, `)`, `.` — anything outside `[A-Za-z0-9_$]`), this
 * check does not fire either, and the same corruption is still possible
 * in principle. Round 3 F2 measured the residual directly rather than
 * asserting it away: of the 19 regex-shaped matches that still survive
 * in the corpus's Markdown files after this check (round 2's own count),
 * NONE has a backtick inside its matched span — every survivor is either
 * a genuine regex literal in a fenced code sample or ASCII-art/prose that
 * happens to satisfy the grammar without ever touching a `` ` `` — so the
 * residual is 0 of 25,553 corpus files and 0 of those 19 matches, not
 * merely untested. The only check that closes the family completely is
 * counting backticks in the consumed span and rejecting an odd count —
 * which is exactly the shape a real `` /`foo`/ `` regex literal (a
 * pattern that legitimately contains backticks) also has, so rejecting
 * it would re-introduce the over-decline this PR's own first-pass
 * heuristic was rejected for (#3120's own history). Left as a measured,
 * documented limit rather than tightened further.
 */
function skipRegexLiteral(line: string, start: number): number {
	let j = start + 1;
	let inClass = false;
	while (j < line.length) {
		const c = line[j];
		if (c === "\\") {
			j += 2;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			j += 1;
			continue;
		}
		if (c === "[") {
			inClass = true;
			j += 1;
			continue;
		}
		if (c === "/") {
			let k = j + 1;
			while (k < line.length && REGEX_FLAG_CHARS.includes(line[k] ?? ""))
				k += 1;
			if (k < line.length && /[A-Za-z0-9_$]/.test(line[k] ?? "")) return -1;
			return j + 1;
		}
		j += 1;
	}
	return -1; // unterminated on this line; not a regex literal after all
}

/**
 * One boolean per line: true when the line sits *inside* a multi-line
 * template literal (or a `${ … }` substitution nested in one), so its leading
 * space is alignment on the surrounding text or expression, not a nesting
 * unit — the same shape as {@link blockCommentInteriorMask} for `/* … *\/`
 * (#3059, a fourth member of AGENTS.md defect 49). The opener line itself is
 * false (its own indentation *is* structural); a backtick inside a `//` line
 * comment or a quoted string must not open a template (`advanceTemplateState`
 * resolves both before treating a backtick as an opener); `${ … }` nesting
 * and escaped backticks are tracked through the frame stack so neither an
 * object literal inside a substitution nor an escaped backtick in template
 * text closes anything early. A template that never closes by EOF was
 * (like an unterminated block comment) something this lexer misread — a
 * backtick inside a regex literal, say — so its lines are left false rather
 * than silently swallowed.
 */
export function templateLiteralInteriorMask(lines: string[]): boolean[] {
	const mask: boolean[] = Array.from({ length: lines.length }, () => false);
	const stack: TemplateFrame[] = [];
	let openLine = -1;
	for (const [i, line] of lines.entries()) {
		if (hasLiveFrame(stack)) {
			mask[i] = true;
		} else {
			openLine = i;
		}
		advanceTemplateState(line, stack);
	}
	if (hasLiveFrame(stack)) {
		for (let i = openLine + 1; i < lines.length; i += 1) mask[i] = false;
	}
	return mask;
}

function structuralLines(lines: string[]): string[] {
	const blockCommentMask = blockCommentInteriorMask(lines);
	const templateMask = templateLiteralInteriorMask(lines);
	return lines.filter(
		(_, index) => !blockCommentMask[index] && !templateMask[index],
	);
}

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) [left, right] = [right, left % right];
	return left;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
