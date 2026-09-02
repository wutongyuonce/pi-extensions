/**
 * Mechanical scan for the "skip that reports as a pass" shape (#2089,
 * AGENTS.md test-authoring screen 2).
 *
 * A test whose body bare-`return`s before it reaches any assertion is reported
 * by Vitest as PASSED, not skipped. The suite then claims coverage it never
 * had, and the claim is loudest exactly where it is least true: a
 * `if (process.platform !== "win32") return;` gate reports green on every one
 * of CI's ubuntu-latest runs while asserting nothing at all. The correct
 * spelling is `it.skipIf(cond)(...)` (declarative, visible in the run summary)
 * or `ctx.skip(reason)` before the return (visible, with a reason attached).
 *
 * The detector is deliberately SYNTACTIC and deliberately conservative — it
 * flags only a bare `return;` that sits at the test callback's own statement
 * level and precedes every assertion in that body. Three consequences worth
 * knowing before you extend it:
 *
 * - **Strings are blanked first.** `tests/clients/tree-sitter-c-rules.test.ts`
 *   feeds the C parser a fixture whose body is `return;`. That is a string, not
 *   a test's control flow, and a scan that reads it as code flags a healthy
 *   test forever.
 * - **Nested function bodies are excluded.** A `return` inside a `forEach`
 *   callback, a `waitFor` predicate or an event handler is ordinary control
 *   flow. Only the callback's OWN statement level can end the test early.
 *   Block braces (`if`, `try`, `catch`, loops) are NOT function bodies — the
 *   compliant `catch { ctx.skip(); return; }` sites live there, and so do the
 *   offenders.
 * - **An assertion anywhere earlier clears the return.** A test that asserts
 *   and then returns has already done its job; the shape this guards is the
 *   body that returns having asserted nothing.
 *
 * Known limits, named rather than papered over:
 *
 * - A test declared through an ALIAS (`const d = it.skipIf(...)`, as in
 *   `tests/clients/installer/posix-group-kill.test.ts`) is invisible to the
 *   walk, which keys on a literal `it`/`test` callee. That alias form is
 *   already the declarative spelling this guard pushes people toward, so the
 *   blind spot points the safe way.
 * - An assertion reachable only inside a nested callback counts as an
 *   assertion. Deciding otherwise needs reachability, not a syntax walk.
 * - A callback passed by REFERENCE (`it("name", handler)`) has no body at the
 *   call site, so there is nothing to walk.
 * - Once a `skip` call is seen, every later return in that body is cleared,
 *   including one on a path the skip does not cover.
 * - `return undefined;` (and any other valued return) is not a bare return:
 *   {@link isBareReturnAt} requires `;` or `}` immediately after the keyword.
 *   It is the same defect wearing a value, and the walk does not see it.
 * - The assertion needle is `assert[\w$]*` followed by `.` or `(`, so an
 *   ordinary identifier that happens to start with `assert` — `assertions.`,
 *   `assertCount(` — clears the body without asserting anything.
 * - {@link SKIP_CALL} accepts any receiver outside the it/test/describe/suite
 *   blocklist, so an unrelated `queue.skip(3)` reads as a skip call.
 * - An ASI bare `return` with no semicolon is likewise invisible; oxfmt writes
 *   the semicolon, so it cannot survive a formatted commit here.
 *
 * Every one of these is a false NEGATIVE, the direction a guard should fail in:
 * the sweep can miss a defect, but it cannot manufacture one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles, relativePosix, stripSource } from "./sweep-kit.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** One test body that ends early without asserting and without skipping. */
export interface VacuousSkip {
	/** Repo-relative posix path of the test file. */
	file: string;
	/** 1-based line of the offending `return`. */
	line: number;
	/** The test's name, as written in its first argument. */
	testName: string;
}

/** Stable identity for exempting one reviewed site. */
export function vacuousSkipKey(entry: {
	file: string;
	testName: string;
}): string {
	return `${entry.file}:${entry.testName}`;
}

/**
 * An assertion — anything the repo uses to make a claim. `assert[\w$]*` on
 * purpose: `assertNonEmptyScan(`, `assertGrammarAvailable(` and friends are
 * assertions under a longer name, and a test that calls one has not returned
 * vacuously.
 */
const ASSERTION = /(?<![\w$.])(?:expect|expectTypeOf|assert[\w$]*)\s*[.(]/;

/** `ctx.skip(...)` / `skip(...)` / `this.skip()`, but never `it.skip(...)`. */
const SKIP_CALL = /(?<![\w$])(?:([\w$]+)\s*\.\s*)?skip\s*\(/g;

const SKIP_QUALIFIER_BLOCKLIST = new Set(["it", "test", "describe", "suite"]);

/** Modifiers that take their own argument list before the test call. */
const ARGUMENT_TAKING_MODIFIERS = new Set(["each", "skipIf", "runIf", "for"]);

/** `(`-introducing keywords whose `) {` opens a BLOCK, not a function body. */
const CONTROL_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"with",
]);

/** Bare-brace keywords — `try {`, `else {`, `do {`, `finally {`, `catch {`. */
const BLOCK_KEYWORDS = new Set(["try", "else", "do", "finally", "catch"]);

function skipBefore(body: string): boolean {
	SKIP_CALL.lastIndex = 0;
	for (const match of body.matchAll(SKIP_CALL)) {
		if (!match[1] || !SKIP_QUALIFIER_BLOCKLIST.has(match[1])) return true;
	}
	return false;
}

function prevNonSpace(source: string, from: number): number {
	let i = from;
	while (i >= 0 && /\s/.test(source[i])) i--;
	return i;
}

function wordEndingAt(source: string, end: number): string {
	if (end < 0 || !/[\w$]/.test(source[end])) return "";
	let start = end;
	while (start > 0 && /[\w$]/.test(source[start - 1])) start--;
	return source.slice(start, end + 1);
}

function matchingOpenParen(source: string, closeIndex: number): number {
	let depth = 0;
	for (let i = closeIndex; i >= 0; i--) {
		if (source[i] === ")") depth++;
		else if (source[i] === "(") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Does the `{` at `index` open a FUNCTION body (as opposed to a block or an
 * object literal)? Decided from the preceding token: `=> {` and `) {` are
 * function bodies unless that `)` closes a control-flow head.
 */
function isFunctionBrace(source: string, index: number): boolean {
	const j = prevNonSpace(source, index - 1);
	if (j < 0) return false;
	if (source[j] === ">" && source[j - 1] === "=") return true;
	if (source[j] === ")") {
		const open = matchingOpenParen(source, j);
		if (open < 0) return false;
		const head = wordEndingAt(source, prevNonSpace(source, open - 1));
		return !CONTROL_KEYWORDS.has(head);
	}
	const word = wordEndingAt(source, j);
	if (word) return !BLOCK_KEYWORDS.has(word);
	return false;
}

function matchingCloseBrace(source: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function skipGroup(source: string, openIndex: number, close: string): number {
	const open = source[openIndex];
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === open) depth++;
		else if (source[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Walk from an `it`/`test` identifier through its modifier chain to the `(`
 * that opens the TEST call itself — `it(`, `it.only(`, `it.each([...])(`,
 * `it.skipIf(cond)(`, ``it.each`table`(``. Returns -1 when the chain does not
 * end in a call (`it.todo` with no parens, a bare mention).
 */
function testCallParen(source: string, identifierEnd: number): number {
	let i = identifierEnd;
	let lastModifier = "";
	for (;;) {
		i = prevNonSpaceForward(source, i);
		if (i >= source.length) return -1;
		const ch = source[i];
		if (ch === ".") {
			const start = prevNonSpaceForward(source, i + 1);
			let end = start;
			while (end < source.length && /[\w$]/.test(source[end])) end++;
			if (end === start) return -1;
			lastModifier = source.slice(start, end);
			i = end;
			continue;
		}
		if (ch === "`" && ARGUMENT_TAKING_MODIFIERS.has(lastModifier)) {
			const close = source.indexOf("`", i + 1);
			if (close < 0) return -1;
			lastModifier = "";
			i = close + 1;
			continue;
		}
		if (ch === "(") {
			if (!ARGUMENT_TAKING_MODIFIERS.has(lastModifier)) return i;
			const close = skipGroup(source, i, ")");
			if (close < 0) return -1;
			lastModifier = "";
			i = close + 1;
			continue;
		}
		return -1;
	}
}

function prevNonSpaceForward(source: string, from: number): number {
	let i = from;
	while (i < source.length && /\s/.test(source[i])) i++;
	return i;
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
	return line;
}

/**
 * The test's name: the first argument, sliced out of the RAW source.
 * `stripSource` preserves every index, so the delimiters found in the stripped
 * text address the same characters in the original.
 */
function testNameAt(raw: string, stripped: string, callParen: number): string {
	const start = prevNonSpaceForward(stripped, callParen + 1);
	const quote = stripped[start];
	if (quote !== '"' && quote !== "'" && quote !== "`") return "";
	const close = stripped.indexOf(quote, start + 1);
	if (close < 0) return "";
	return raw.slice(start + 1, close);
}

const TEST_IDENTIFIER = /(?<![\w$.])(?:it|test)(?![\w$])/g;

/**
 * Index of the `{` opening the test's callback body, or -1 when the call has
 * no inline callback (an extracted handler, a concise arrow body). Nested
 * groups are skipped whole so that a brace inside an options object or an
 * `each` table cannot be mistaken for the body.
 */
function callbackBodyBrace(
	stripped: string,
	callParen: number,
	callEnd: number,
): number {
	for (let i = callParen + 1; i < callEnd; i++) {
		const ch = stripped[i];
		if (ch === "(" || ch === "[") {
			i = skipGroup(stripped, i, ch === "(" ? ")" : "]");
			if (i < 0) return -1;
			continue;
		}
		if (ch !== "{") continue;
		if (isFunctionBrace(stripped, i)) return i;
		i = matchingCloseBrace(stripped, i);
		if (i < 0) return -1;
	}
	return -1;
}

/** Every vacuous early return in one file's source text. */
export function scanVacuousSkipsInSource(
	file: string,
	raw: string,
): VacuousSkip[] {
	const stripped = stripSource(raw, { strings: "blank" });
	const found: VacuousSkip[] = [];
	TEST_IDENTIFIER.lastIndex = 0;
	for (const match of stripped.matchAll(TEST_IDENTIFIER)) {
		const callParen = testCallParen(stripped, match.index + match[0].length);
		if (callParen < 0) continue;
		const callEnd = skipGroup(stripped, callParen, ")");
		if (callEnd < 0) continue;
		const bodyOpen = callbackBodyBrace(stripped, callParen, callEnd);
		if (bodyOpen < 0) continue;
		const bodyClose = matchingCloseBrace(stripped, bodyOpen);
		if (bodyClose < 0) continue;
		const hit = firstVacuousReturn(stripped, bodyOpen, bodyClose);
		if (hit < 0) continue;
		found.push({
			file,
			line: lineOf(stripped, hit),
			testName: testNameAt(raw, stripped, callParen),
		});
	}
	return found;
}

/**
 * Index of the first bare `return` at the callback's own statement level that
 * has neither asserted nor skipped, or -1. Function braces raise the depth;
 * block braces do not, because a compliant `catch { ctx.skip(); return; }` and
 * a bare `if (!win32) return;` both live inside blocks.
 */
function firstVacuousReturn(
	stripped: string,
	bodyOpen: number,
	bodyClose: number,
): number {
	let functionDepth = 0;
	const braceIsFunction: boolean[] = [];
	for (let i = bodyOpen + 1; i < bodyClose; i++) {
		const ch = stripped[i];
		if (ch === "{") {
			const isFunction = isFunctionBrace(stripped, i);
			braceIsFunction.push(isFunction);
			if (isFunction) functionDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceIsFunction.pop() === true) functionDepth--;
			continue;
		}
		if (functionDepth > 0 || !isBareReturnAt(stripped, i)) continue;
		const before = stripped.slice(bodyOpen + 1, i);
		return ASSERTION.test(before) || skipBefore(before) ? -1 : i;
	}
	return -1;
}

/** A `return` statement with no value, starting at `i`. */
function isBareReturnAt(stripped: string, i: number): boolean {
	if (stripped[i] !== "r" || stripped.slice(i, i + 6) !== "return")
		return false;
	if (i > 0 && /[\w$.]/.test(stripped[i - 1])) return false;
	const after = prevNonSpaceForward(stripped, i + 6);
	return stripped[after] === ";" || stripped[after] === "}";
}

/**
 * Every `*.test.ts` under `tests/`, minus the fixture tree — vitest treats
 * `tests/fixtures` as INPUT to tests rather than as tests, and its contents are
 * deliberately shaped like the code under test.
 */
export function listTestFiles(): string[] {
	return listSourceFiles(path.join(repoRoot, "tests"), {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	}).filter((file) => file.endsWith(".test.ts"));
}

/** Scan the whole `tests/` tree for tests that pass by returning early. */
export function scanVacuousSkips(): VacuousSkip[] {
	return listTestFiles().flatMap((absolute) =>
		scanVacuousSkipsInSource(
			relativePosix(repoRoot, absolute),
			fs.readFileSync(absolute, "utf8"),
		),
	);
}
