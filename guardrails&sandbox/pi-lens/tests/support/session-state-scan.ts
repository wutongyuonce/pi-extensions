/**
 * Two mechanical scans over `clients/` that back the session-state lifecycle
 * registry — #1635 item 2.
 *
 * 1. {@link sessionStartResetNames} DERIVES the set of reset functions
 *    `handleSessionStart` actually reaches. The registry then asserts against
 *    that set instead of a hand-copied list, so a reset that is written but
 *    never called — the #1266/#1490/#1497/#1535/#1537/#1625 defect shape, eight
 *    bugs in one arc — cannot be declared "wired" on faith.
 * 2. {@link scanSessionStateCandidates} finds the source files that LOOK like
 *    they own session-scoped state, so the registry can be checked for
 *    coverage. See {@link SWEEP_HEURISTIC_LIMITS} for what this can and cannot
 *    see; the boundary is documented rather than papered over.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles, relativePosix, stripSource } from "./sweep-kit.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/** Every `.ts` file under `clients/`, minus declarations and tests. */
export function clientSourceFiles(dir = CLIENTS_ROOT): string[] {
	return listSourceFiles(dir, { extensions: [".ts"], skipTests: true });
}

/** `clients/`-relative posix path for an absolute source path. */
export function clientsRelative(absolute: string): string {
	return relativePosix(CLIENTS_ROOT, absolute);
}

// ── 1. What session_start actually resets ────────────────────────────────────

/**
 * Blank out every comment body and string literal, preserving length and line
 * breaks so positions and line numbers still line up with the original.
 *
 * Now a thin alias over the sweep kit's single stripper (#1755) — the kit owns
 * the lexer, the regex-position rule and the recovery guards, and every sweep
 * in the repo shares one implementation instead of seven. Kept as a named
 * export because `host-event-shape-scan.ts` and the finding-delivery gate
 * import it, and because this name states which POLICY the session-state walk
 * needs: string contents BLANKED, so a reset named inside a string is not read
 * as a call.
 *
 * This is load-bearing, not tidiness. Review round R1 reinstated #1535's bug
 * by REPLACING the real `resetZizmorTokenAvailability()` call with a comment
 * that merely names it, and the conformance suite stayed green, because the
 * reachability walk regexed raw source. `runtime-session.ts`'s reset block is
 * mostly `#issue`-narrative comments that name resets by hand, so that
 * false-negative mode was armed on real source, not hypothetical.
 */
export function stripCommentsAndStrings(source: string): string {
	return stripSource(source, { strings: "blank" });
}

/**
 * Extract a named function's body by brace matching from its `{`.
 *
 * `source` must already be {@link stripCommentsAndStrings}-processed, so the
 * brace counter cannot be thrown by a brace inside a comment or string and the
 * call extraction cannot be fooled by a comment naming a call.
 */
function functionBody(source: string, name: string): string | undefined {
	const declaration = new RegExp(
		`\\bfunction\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`,
	);
	const match = declaration.exec(source);
	if (!match) return undefined;
	// Skip the PARAMETER LIST before looking for the body's `{`. A default
	// parameter value is very often an object literal (`options: T = {}`), and
	// taking the first `{` after the name would return that empty literal as
	// the whole function body — silently reporting a function that calls
	// nothing. `resetLSPService(options: LSPShutdownOptions = {})` hit exactly
	// that while this scan was being written.
	let parenDepth = 0;
	let afterParams = -1;
	for (let i = match.index + match[0].length - 1; i < source.length; i++) {
		if (source[i] === "(") parenDepth++;
		else if (source[i] === ")") {
			parenDepth--;
			if (parenDepth === 0) {
				afterParams = i + 1;
				break;
			}
		}
	}
	if (afterParams < 0) return undefined;
	const openBrace = source.indexOf("{", afterParams);
	if (openBrace < 0) return undefined;
	let depth = 0;
	for (let i = openBrace; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(openBrace, i + 1);
		}
	}
	return undefined;
}

/** Bare-identifier call targets inside `body` (`foo(...)`, never `x.foo(...)`). */
function bareCalls(body: string): string[] {
	const names = new Set<string>();
	for (const match of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
		names.add(match[2]);
	}
	return [...names];
}

/**
 * Extract calls from the closure's own control flow, excluding callback
 * bodies. Control-flow blocks remain visible, so a reset behind an `if` still
 * counts as directly wired, while a reset deferred to `setImmediate`, `then`,
 * or `catch` does not. The source is stripped, so brace matching is safe.
 */
function directClosureCalls(body: string): string[] {
	const visible = body.split("");
	const maskRange = (start: number, end: number) => {
		for (let i = start; i < end; i++) visible[i] = " ";
	};
	const matchingBrace = (open: number): number => {
		let depth = 0;
		for (let i = open; i < body.length; i++) {
			if (body[i] === "{") depth++;
			else if (body[i] === "}" && --depth === 0) return i;
		}
		return body.length;
	};
	const functionBodyOpen = (start: number): number => {
		let parens = 0;
		for (let i = start + "function".length; i < body.length; i++) {
			if (body[i] === "(") parens++;
			else if (body[i] === ")") parens--;
			else if (body[i] === "{" && parens === 0) return i;
		}
		return body.length;
	};
	const arrowExpressionEnd = (start: number): number => {
		let parens = 0;
		let brackets = 0;
		for (let i = start; i < body.length; i++) {
			switch (body[i]) {
				case "(":
					parens++;
					break;
				case ")":
					if (parens === 0 && brackets === 0) return i;
					parens--;
					break;
				case "[":
					brackets++;
					break;
				case "]":
					brackets--;
					break;
				case ",":
				case ";":
					if (parens === 0 && brackets === 0) return i;
			}
		}
		return body.length;
	};

	for (let i = 0; i < body.length - 1; i++) {
		if (
			body.startsWith("function", i) &&
			!/[\w$]/.test(body[i - 1] ?? "") &&
			!/[\w$]/.test(body[i + "function".length] ?? "")
		) {
			const open = functionBodyOpen(i);
			if (open < body.length) {
				maskRange(open, matchingBrace(open) + 1);
				i = open;
			}
		}
		if (body[i] === "=" && body[i + 1] === ">") {
			let next = i + 2;
			while (/\s/.test(body[next] ?? "")) next++;
			if (body[next] === "{") {
				maskRange(next, matchingBrace(next) + 1);
				i = next;
			} else {
				maskRange(next, arrowExpressionEnd(next));
				i = next;
			}
		}
	}
	return bareCalls(visible.join(""));
}

/**
 * The bare-identifier calls made inside `name`'s body in `source`, with
 * comments and string literals removed first. Exported so the suite can pin
 * this behavior against synthetic source rather than only against whatever
 * happens to be in `clients/` today — see the R1 probes in
 * `tests/clients/session-state-conformance.test.ts`.
 */
export function callsWithinFunction(source: string, name: string): string[] {
	const body = functionBody(stripCommentsAndStrings(source), name);
	return body ? bareCalls(body) : [];
}

/**
 * Only reset-shaped names are followed. Walking EVERY call out of
 * `handleSessionStart` would drag in most of the codebase and answer a
 * different question; the registry's claim is specifically "this reset runs at
 * session_start", so the walk follows resets.
 */
const RESET_NAME = /^_?(reset|clear)[A-Z_]/;

/** Host built-ins that match {@link RESET_NAME} but reset nothing of ours. */
const BUILTIN_CLEARS = new Set([
	"clearTimeout",
	"clearInterval",
	"clearImmediate",
]);

/**
 * Reset-shaped (or rotate-shaped) bare call names worth following. Shared by
 * the `handleSessionStart` walk and the session_start-closure walk (#2319).
 */
function isResetName(name: string): boolean {
	return (
		(RESET_NAME.test(name) || /^rotate[A-Z]/.test(name)) &&
		!BUILTIN_CLEARS.has(name)
	);
}

let cachedResetNames: Set<string> | undefined;

/**
 * The reset functions reachable from `handleSessionStart` through bare
 * function calls, transitively.
 *
 * Known imprecision, stated rather than hidden:
 * - METHOD calls are not followed (`sessionFacts.clearAll()`,
 *   `runtime.resetForSession()`). Register such state under the exported
 *   function that ENCLOSES the method call (`resetDispatchBaselines`), which
 *   is the seam a caller can actually reach anyway.
 * - A reset called only inside a conditional still counts as reached. This
 *   scan answers "is it wired", not "does it always run".
 * - Name collisions across modules resolve to whichever file defines the name
 *   first. No two reset functions in `clients/` share a name today, and
 *   {@link resetNameDefinitions} exposes the mapping so a future collision is
 *   visible rather than silent.
 */
export function sessionStartResetNames(): Set<string> {
	if (cachedResetNames) return cachedResetNames;
	const sources = new Map<string, string>();
	for (const absolute of clientSourceFiles()) {
		// Stripped ONCE per file, then used for the declaration search, the brace
		// match and the call extraction alike (R1).
		sources.set(
			clientsRelative(absolute),
			stripCommentsAndStrings(fs.readFileSync(absolute, "utf8")),
		);
	}

	const bodyOf = (name: string): string | undefined => {
		for (const source of sources.values()) {
			const body = functionBody(source, name);
			if (body) return body;
		}
		return undefined;
	};

	const entry = bodyOf("handleSessionStart");
	if (!entry) {
		throw new Error(
			"session-state scan: could not find handleSessionStart's body in clients/ — " +
				"the session_start entry point moved or was renamed; update this scan.",
		);
	}

	const reached = new Set<string>();
	const queue = bareCalls(entry).filter(isResetName);
	while (queue.length > 0) {
		const name = queue.pop() as string;
		if (reached.has(name)) continue;
		reached.add(name);
		const body = bodyOf(name);
		if (!body) continue;
		for (const called of bareCalls(body)) {
			if (isResetName(called) && !reached.has(called)) queue.push(called);
		}
	}
	cachedResetNames = reached;
	return reached;
}

/** Which file defines each reset-shaped exported function, for collision checks. */
export function resetNameDefinitions(): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	for (const absolute of clientSourceFiles()) {
		const source = stripCommentsAndStrings(fs.readFileSync(absolute, "utf8"));
		for (const match of source.matchAll(
			/^export function (_?(?:reset|clear)[A-Za-z0-9_]*)/gm,
		)) {
			const file = clientsRelative(absolute);
			byName.set(match[1], [...(byName.get(match[1]) ?? []), file]);
		}
	}
	return byName;
}

// ── 1b. What index.ts's session_start closure resets directly (#2319) ────────

/** The repository's root `index.ts`, which owns the session_start closure. */
function indexEntrySource(): string {
	return fs.readFileSync(path.join(repoRoot, "index.ts"), "utf8");
}

/**
 * The bare calls made DIRECTLY inside index.ts's `pi.on("session_start", ...)`
 * closure, with comments and string literals removed first. Exported so the
 * suite can pin this walker against synthetic source, exactly like
 * {@link callsWithinFunction}.
 *
 * The closure is anchored on its raw wrapper registration
 * (`wrapSessionEventHandler("session_start", async (event, ctx) => {`) and
 * brace-matched on the STRIPPED source, so a brace inside a string or comment
 * cannot truncate the body and a call named only in prose is not a call (the
 * same R1/S1 discipline the `handleSessionStart` walker obeys).
 */
export function callsWithinSessionStartClosure(source: string): string[] {
	const anchor =
		/wrapSessionEventHandler\(\s*"session_start"\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/.exec(
			source,
		);
	if (!anchor) return [];
	const openBrace = anchor.index + anchor[0].length - 1;
	const stripped = stripCommentsAndStrings(source);
	let depth = 0;
	for (let i = openBrace; i < stripped.length; i++) {
		if (stripped[i] === "{") depth++;
		else if (stripped[i] === "}") {
			depth--;
			if (depth === 0)
				return directClosureCalls(stripped.slice(openBrace, i + 1));
		}
	}
	return [];
}

let cachedClosureResetNames: Set<string> | undefined;

/**
 * The reset-shaped bare calls directly inside index.ts's session_start closure
 * — #2319.
 *
 * {@link sessionStartResetNames} walks `handleSessionStart`'s reachable call
 * graph. A few resets are deliberately placed in the session_start CLOSURE
 * itself rather than inside `handleSessionStart`'s body: `resetCurrentPhaseForSession`
 * (must sit inside the #473 concurrent-secondary gate but before
 * `handleSessionStart` runs — #1723 review F4), the concurrent-session bind
 * rollup reset (must run only on the primary continuation path — #2249), and
 * the verified-attribution tally reset. The registry marks such entries with
 * `sessionStartClosureReset`, and this walk is the derived evidence the
 * conformance suite checks them against — a reset that is registered as
 * closure-wired but never called here reds exactly like an unwired
 * `handleSessionStart` reset does.
 */
export function sessionStartClosureResetNames(): Set<string> {
	if (cachedClosureResetNames) return cachedClosureResetNames;
	const names =
		callsWithinSessionStartClosure(indexEntrySource()).filter(isResetName);
	cachedClosureResetNames = new Set(names);
	return cachedClosureResetNames!;
}

// ── 2. Which files look like they own session-scoped state ───────────────────

/** A source file matching the session-scoped-state code pattern. */
export interface SessionStateCandidate {
	/** `clients/`-relative posix path. */
	file: string;
	/** Module-level `Map`/`Set` declarations found (name only). */
	containers: string[];
	/** Exported reset-shaped function names found. */
	resets: string[];
	/** True when at least one reset is an explicitly test-only seam. */
	hasTestOnlyReset: boolean;
	/** True when the file calls `getProcessSingleton(...)` — state on the
	 *  process-wide container (#2146/#2319). The container's VALUE lives off
	 *  module scope, so this is the only signal the file owns process-lifetime
	 *  (possibly session-scoped) state. */
	hasProcessSingleton: boolean;
}

/**
 * Module-level (column-zero) `const`/`let` bound to a `Map`, `Set`,
 * `WeakMap`, `WeakSet` or the repo's `PathKeyedMap`. Column zero is the
 * signal for "module scope" — a container declared inside a function is
 * per-call state and re-armed by construction.
 */
const CONTAINER_DECLARATION =
	/^(?:const|let)\s+([A-Za-z_$][\w$]*)[^=\n]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet|PathKeyedMap)\b/gm;

/** An exported reset-shaped function. */
const EXPORTED_RESET = /^export function (_?(?:reset|clear)[A-Za-z0-9_]*)/gm;

/** A reset seam whose name says it exists for tests. */
const TEST_ONLY_RESET = /ForTests?$|ForTesting$/;

/**
 * A call to `getProcessSingleton(` — the file acquires state on the
 * process-wide container ({@link clients/process-singletons.ts}): a cell whose
 * correctness depends on being the process's only copy. The VALUE lives off
 * module scope on `globalThis`, so the module-scope container regex cannot see
 * it; this is the file-level signal that state is held at process lifetime and
 * must be classified (session_start / turn_end / process_lifetime) like any
 * other candidate.
 *
 * NO `g` flag, deliberately: `.test()` keeps `lastIndex` between calls on a
 * global regex, so scanning the second file would resume mid-string and a
 * legitimate call ahead of the cursor would be missed (this exact bug turned
 * `session-start-observability.ts` invisible in the first draft of #2319).
 */
const PROCESS_SINGLETON_CALL = /getProcessSingleton\s*\(/;

/**
 * What this heuristic catches, and what it structurally cannot.
 *
 * CATCHES — a module-level `Map`/`Set`/`PathKeyedMap` in a file that also
 * exports a reset-shaped function; a `getProcessSingleton(...)` call in a file
 * that also exports one; and any file exporting a `_reset…ForTests`-style seam.
 * Those pairings are the observed shape of every process-lifetime-latch bug in
 * the #1266–#1625 arc (and #2319's process-singleton twin): state that outlives
 * a session plus a reset nobody calls at the session boundary.
 *
 * MISSES — and each of these is a real, currently-unguarded class:
 * 1. **Scalar state.** `let installRetryGeneration = 0`, a boolean latch, a
 *    `number` cooldown deadline (`lsp/server.ts`'s
 *    `directLspCommandUnavailableUntil`). No container, so no signal.
 * 2. **Closure state.** `createAvailabilityLatch()`'s verdict lives in a
 *    closure, not a module-level container. The registry covers these by hand
 *    because the scan cannot.
 * 3. **State with no reset seam at all.** The scan needs the pairing; state
 *    nobody ever wrote a reset for is invisible to it. This is the worst
 *    blind spot, because "no reset exists" is a stronger version of the bug
 *    the sweep is looking for.
 * 4. **Instance fields.** `private readonly cache = new Map()` on a class the
 *    bootstrap builds once is session-scoped in practice and indented in
 *    source, so column-zero matching skips it.
 * 5. **Semantics.** The scan cannot tell a session-scoped dedupe set from a
 *    frozen lookup table built once at import. That judgment stays in the
 *    registry and in {@link SessionStateExemption}'s reasons.
 *
 * The #1817 symbol-count pin narrows the FIRST four of these from "invisible"
 * to "a total the pin table tracks", but it inherits one more blind spot of
 * its own:
 *
 * 6. **Substitution.** Adding one new uncleared container while removing an
 *    already-covered one leaves the file's total count unchanged, so the pin
 *    sees nothing. The pin proves the COUNT is deliberate, not that every
 *    individual symbol behind it still is — a swap that nets to zero is
 *    invisible to a total the same way it would be to a checksum. Full
 *    symbol-to-reset attribution (#1817's option (a), not taken here) is the
 *    only way to close this; the count pin's job is the cheaper, LOUDER
 *    common case where a symbol is added without one being removed.
 *
 * The sweep is therefore a floor, not a proof of coverage. It makes a NEW
 * matching file impossible to add without a decision; it does not certify
 * that everything session-scoped is registered.
 */
export const SWEEP_HEURISTIC_LIMITS = [
	"scalar (non-container) session state",
	"closure-held state, e.g. createAvailabilityLatch's verdict",
	"state with no reset seam at all",
	"instance fields on bootstrap-lived singletons",
	"session-scoped vs import-time-constant semantics",
	"substitution: add one container, remove another, and the #1817 symbol-count pin sees no change",
	"getProcessSingleton cells are a SIGNAL, but the cell VALUE lives off module scope on globalThis — a session-scoped cell is still only caught when its file also exports a reset (the pair-with-reset rule), and the cell itself is registered/exempted by hand judgment",
] as const;

let cachedCandidates: SessionStateCandidate[] | undefined;

/**
 * Every source file under `dir` matching the session-scoped-state code
 * pattern. Defaults to (and caches) the real `clients/` tree; a caller may
 * pass an override root to run the same detection against a synthetic
 * fixture tree — `tests/clients/session-state-conformance.test.ts` uses this
 * to regression-test the #1817 symbol-count pin against a fixture that
 * cannot drift out from under the test the way the real tree can.
 */
export function scanSessionStateCandidates(
	dir = CLIENTS_ROOT,
): SessionStateCandidate[] {
	const useCache = dir === CLIENTS_ROOT;
	if (useCache && cachedCandidates) return cachedCandidates;
	const found: SessionStateCandidate[] = [];
	for (const absolute of clientSourceFiles(dir)) {
		// Stripped for the same reason the reachability walk is (R1): a
		// commented-out declaration or reset export is not one.
		const source = stripCommentsAndStrings(fs.readFileSync(absolute, "utf8"));
		const containers = [...source.matchAll(CONTAINER_DECLARATION)].map(
			(m) => m[1],
		);
		const resets = [...source.matchAll(EXPORTED_RESET)].map((m) => m[1]);
		if (resets.length === 0) continue;
		const hasTestOnlyReset = resets.some((r) => TEST_ONLY_RESET.test(r));
		const hasProcessSingleton = PROCESS_SINGLETON_CALL.test(source);
		// Signal A (container + reset), signal B (an explicit test-only reset
		// seam, which by itself says "this module holds state tests must undo"),
		// or signal C (a getProcessSingleton cell + reset — #2319).
		if (containers.length === 0 && !hasTestOnlyReset && !hasProcessSingleton)
			continue;
		found.push({
			file: relativePosix(dir, absolute),
			containers,
			resets,
			hasTestOnlyReset,
			hasProcessSingleton,
		});
	}
	if (useCache) cachedCandidates = found;
	return found;
}

/** A scanned file the registry deliberately does not cover, and why. */
export type SessionStateExemption = string;
