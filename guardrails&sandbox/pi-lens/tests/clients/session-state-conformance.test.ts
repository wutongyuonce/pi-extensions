/**
 * Session-state lifecycle conformance and sweep — #1635 item 2.
 *
 * Three claims, checked three different ways:
 *
 * 1. **Re-arm.** Where a probe exists, arm the state and prove the registered
 *    reset disarms it. This is the only check that touches real state.
 * 2. **Wiring.** Every `session_start` entry's reset must be reachable from
 *    `handleSessionStart` — derived from the source, not from a list anyone
 *    maintains. A reset that exists but is never called is the exact shape of
 *    #1266, #1490, #1497, #1535, #1537 and #1625.
 * 3. **Coverage.** Every file the sweep flags as session-state-shaped is
 *    registered or exempted with a reason.
 *
 * Claim 3 runs on `tests/support/sweep-kit.ts` (#1755) — the shared
 * registered-or-fail machinery, so this sweep and the six others stop
 * re-deriving the same semantics. The stripper behind claims 1 and 2 comes
 * from the same kit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXEMPT_SESSION_STATE_FILES,
	SESSION_STATE_REGISTRY,
	SESSION_STATE_SYMBOL_COUNTS,
	_resetRegistryProbeState,
} from "../support/session-state-registry.js";
import {
	SWEEP_HEURISTIC_LIMITS,
	callsWithinFunction,
	callsWithinSessionStartClosure,
	clientSourceFiles,
	resetNameDefinitions,
	scanSessionStateCandidates,
	sessionStartClosureResetNames,
	sessionStartResetNames,
	stripCommentsAndStrings,
} from "../support/session-state-scan.js";
import { auditRegistry, auditSymbolCounts } from "../support/sweep-kit.js";

afterEach(() => _resetRegistryProbeState());

describe("session-state registry — shape", () => {
	it("every entry is uniquely identified", () => {
		const ids = SESSION_STATE_REGISTRY.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every entry states a reason", () => {
		for (const entry of SESSION_STATE_REGISTRY) {
			expect(
				entry.reason.length,
				`${entry.id} needs a real reason`,
			).toBeGreaterThan(30);
		}
	});

	it("every registered reset name resolves to exactly one clients/ module", () => {
		const definitions = resetNameDefinitions();
		for (const entry of SESSION_STATE_REGISTRY) {
			const files = definitions.get(entry.resetName);
			expect(
				files,
				`${entry.id}: no exported ${entry.resetName}`,
			).toBeDefined();
			// A duplicated reset name would make the reachability walk below
			// ambiguous — it resolves by name, so two definitions is a real hazard.
			expect(
				files,
				`${entry.id}: ${entry.resetName} is defined twice`,
			).toHaveLength(1);
		}
	});
});

describe("session-state registry — re-arm conformance", () => {
	const probed = SESSION_STATE_REGISTRY.filter((e) => e.probe);

	it("exercises a probe for the core session latches", () => {
		// Not every entry can be probed without spawning a real tool. This pins a
		// floor so the probe set cannot quietly drain to zero while the registry
		// grows.
		expect(probed.length).toBeGreaterThanOrEqual(5);
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.probe) continue;
		it(`${entry.id} re-arms when ${entry.resetName} runs`, () => {
			const probe = entry.probe as NonNullable<typeof entry.probe>;
			probe.reset();
			expect(probe.isArmed(), `${entry.id} should start armed`).toBe(true);
			probe.arm();
			expect(probe.isArmed(), `${entry.id} arm() did not dirty the state`).toBe(
				false,
			);
			probe.reset();
			expect(probe.isArmed(), `${entry.id} did not re-arm`).toBe(true);
		});
	}
});

// The reachability walk's own correctness, pinned against synthetic source so
// a regression here cannot hide behind whatever happens to be in clients/
// today. Review round R1 (S1) got a fabricated bug past the whole suite by
// swapping a real reset call for a COMMENT naming it: the walk regexed raw
// source, so 37/37 stayed green while the reset was gone. The narrative
// comments in runtime-session.ts's reset block name resets by hand, so this
// was armed on real source, not hypothetical.
describe("session-state scan — walker smuggle probes (R1/S1)", () => {
	const withComment = [
		"function handleSessionStart() {",
		"\t// resetZizmorTokenAvailability(); — #1535 says this belongs here",
		"\tresetDegradationLedger();",
		"}",
	].join("\n");

	it("a reset named only in a comment does not count as called", () => {
		const calls = callsWithinFunction(withComment, "handleSessionStart");
		expect(calls).toContain("resetDegradationLedger");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
	});

	it("a reset named only inside a string literal does not count as called", () => {
		const source = [
			"function handleSessionStart() {",
			'\tdbg("calling resetZizmorTokenAvailability() next");',
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).not.toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("the real call is still found when both forms are present", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// resetZizmorTokenAvailability() — see #1535",
			"\tresetZizmorTokenAvailability();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("a brace inside a comment or string cannot end the body early", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// a stray } in a comment",
			'\tconst s = "another } here";',
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	// The regex branch had no probe at all until review round R2: deleting it
	// wholesale left every other probe here green. These two cover it from both
	// sides — the lexing decision, and the branch's existence.
	it("R2: a phantom call inside a KEYWORD-position regex does not count as called", () => {
		// The reviewer's exploit. Reading the preceding CHARACTER sees the `f` of
		// `typeof`, calls this division, leaves the regex body unstripped, and the
		// wiring check accepts a call that is not there.
		const source = [
			"function handleSessionStart() {",
			"\tif (typeof /resetZizmorTokenAvailability()/) {",
			"\t\tresetDegradationLedger();",
			"\t}",
			"}",
		].join("\n");
		const calls = callsWithinFunction(source, "handleSessionStart");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
		expect(calls).toContain("resetDegradationLedger");
	});

	it("R2: a regex holding an unbalanced brace cannot truncate the body", () => {
		// Reds if the regex branch is deleted: the `{` inside the character class
		// is then counted by the brace matcher, the body never closes, and the
		// call below it disappears.
		const source = [
			"function handleSessionStart() {",
			"\tconst re = /[{]/;",
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("R2: a value-position regex is still lexed as a regex", () => {
		// The control for the keyword fix — narrowing regex position must not
		// swing so far that ordinary regex literals stop being recognized.
		const source = [
			"function handleSessionStart() {",
			'\tconst safe = arg.replace(/"/g, \'""\');',
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("stripping preserves length and line structure", () => {
		const source = 'const a = 1; // note\nconst b = "text";\n';
		const stripped = stripCommentsAndStrings(source);
		expect(stripped).toHaveLength(source.length);
		expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
		expect(stripped).toContain("const a = 1;");
		expect(stripped).not.toContain("note");
		expect(stripped).not.toContain("text");
	});
});

// The closure walker's own correctness, pinned against synthetic source the
// same way the handleSessionStart walker is above (#2319). A reset named only
// in a comment inside the closure, or a brace smuggled through a string, must
// not read as a call — the closure-site registry entries depend on it.
describe("session-state scan — closure walker smuggle probes (#2319)", () => {
	const closureSource = (body: string[]) =>
		[
			"pi.on(",
			'\t"session_start",',
			'\twrapSessionEventHandler("session_start", async (event, ctx) => {',
			...body,
			"\t});",
			");",
		].join("\n");

	it("a reset named only in a comment in the closure does not count as called", () => {
		const source = closureSource([
			"\t\t// resetConcurrentSessionBindRollupCounts(); — #2319 says this belongs here",
			"\t\tresetVerifiedPathAttributionGuessCount();",
		]);
		const calls = callsWithinSessionStartClosure(source);
		expect(calls).toContain("resetVerifiedPathAttributionGuessCount");
		expect(calls).not.toContain("resetConcurrentSessionBindRollupCounts");
	});

	it("a brace inside a string in the closure cannot end the body early", () => {
		const source = closureSource([
			'\t\tconst s = "a } here";',
			"\t\tresetVerifiedPathAttributionGuessCount();",
		]);
		expect(callsWithinSessionStartClosure(source)).toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
	});

	it("the real call is still found when both forms are present", () => {
		const source = closureSource([
			"\t\t// resetVerifiedPathAttributionGuessCount() — see #2319",
			"\t\tresetConcurrentSessionBindRollupCounts();",
		]);
		const calls = callsWithinSessionStartClosure(source);
		expect(calls).toContain("resetConcurrentSessionBindRollupCounts");
		expect(calls).not.toContain("resetVerifiedPathAttributionGuessCount");
	});

	it("a reset deferred to a callback does not count as a direct call", () => {
		const source = closureSource([
			"\t\tsetImmediate(() => resetVerifiedPathAttributionGuessCount());",
			"\t\tPromise.resolve().then(() => {",
			"\t\t\tresetConcurrentSessionBindRollupCounts();",
			"\t\t});",
		]);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetConcurrentSessionBindRollupCounts",
		);
	});

	it("a reset deferred to a function callback does not count as direct", () => {
		const source = closureSource([
			"\t\tsetImmediate(function () {",
			"\t\t\tresetVerifiedPathAttributionGuessCount();",
			"\t\t});",
		]);
		expect(callsWithinSessionStartClosure(source)).not.toContain(
			"resetVerifiedPathAttributionGuessCount",
		);
	});

	it("returns empty when the registration shape changes — the failure is loud, not silent", () => {
		// #2319: if the wrapper/event registration is renamed or reformatted,
		// the derivation yields nothing and every closure-site registry entry
		// goes red through its wiring test. It must never report a phantom set.
		const source = [
			"pi.on(",
			'\t"session_start",',
			"\thonSessionStart(doTheThing);",
			");",
		].join("\n");
		expect(callsWithinSessionStartClosure(source)).toEqual([]);
	});
});

describe("session-state registry — session_start wiring", () => {
	const wired = sessionStartResetNames();
	const closureWired = sessionStartClosureResetNames();

	it("derives a non-trivial reset chain from handleSessionStart", () => {
		// A silent derivation failure (renamed entry point, broken brace match)
		// would make every wiring assertion below vacuously... fail, but this
		// names the cause directly instead of scattering it across 20 tests.
		expect(wired.size).toBeGreaterThan(15);
		expect(wired.has("resetDegradationLedger")).toBe(true);
	});

	it("derives the session_start closure resets from index.ts (#2319)", () => {
		// The closure-site entries below depend on THIS derivation, so a silent
		// failure (renamed wrapper, moved registration) would make their wiring
		// claims vacuous — the same guard the floor above gives `wired`. The
		// exact members can shift with legitimate edits; the three registered
		// ones cannot, or their entries red here.
		expect(closureWired.size).toBeGreaterThanOrEqual(5);
		for (const name of [
			"resetVerifiedPathAttributionGuessCount",
			"resetCurrentPhaseForSession",
			"resetConcurrentSessionBindRollupCounts",
		]) {
			expect(closureWired.has(name)).toBe(true);
		}
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (entry.policy !== "session_start" || entry.gap) continue;
		const sessionStartName = entry.sessionStartResetName ?? entry.resetName;
		it(`${entry.id}: ${sessionStartName} runs at session_start`, () => {
			// #2319: entries whose reset deliberately lives in index.ts's
			// session_start CLOSURE (not handleSessionStart's reachable graph)
			// are checked against the closure derivation. Every other entry
			// keeps the handleSessionStart walk, unchanged.
			const reached = entry.sessionStartClosureReset ? closureWired : wired;
			const site = entry.sessionStartClosureReset
				? "index.ts's session_start closure"
				: "handleSessionStart";
			expect(
				reached.has(sessionStartName),
				`${sessionStartName} is not reachable from ${site}. ` +
					"Either wire it in, change the entry's policy and say why, or drop " +
					"the sessionStartClosureReset marker.",
			).toBe(true);
		});
	}

	// The mirror image, and the more valuable half: a declared gap must still
	// BE a gap. When #1625 wires the disposition reset in, this test fails and
	// forces the registry to stop claiming it is broken.
	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.gap) continue;
		it(`${entry.id}: the declared gap is still real`, () => {
			expect(entry.gap && entry.gap.length).toBeGreaterThan(40);
			expect(
				wired.has(entry.sessionStartResetName ?? entry.resetName),
				`${entry.sessionStartResetName ?? entry.resetName} IS wired at session_start now — delete this entry's ` +
					"`gap` field; the registry must not keep claiming a fixed bug.",
			).toBe(false);
		});
	}

	it("records the gaps this registry currently declares", () => {
		// A named inventory, so a reviewer sees the open population at a glance
		// rather than grepping for `gap:`. Shrinking it is the point of the
		// registry; growing it silently is what this asserts against.
		// One down: #1666 wired package-manager's reset into handleSessionStart,
		// this list's own test went red naming the fix, and the entry lost its
		// `gap`. That is the loop the registry exists to close.
		const gaps = SESSION_STATE_REGISTRY.filter((e) => e.gap).map((e) => e.id);
		expect(gaps).toEqual(["diagnostic-dispositions:deferredThisSession"]);
	});
});

// Migrated to `tests/support/sweep-kit.ts` (#1755). The three coverage claims
// below are now one `auditRegistry` call: registered-or-fail, exemptions that
// require a reason, and stale-exemption self-detection. Behaviour is
// unchanged; the kit also adds the emptiness floor (defect shape 10) that this
// sweep never had — a scan that stops flagging files used to report clean.
describe("session-state sweep — coverage", () => {
	const audit = () =>
		auditRegistry({
			sweepName: "session-state sweep",
			// Two floors, two distinguishable failures (#1755 review F4).
			// `minScanned` catches a dead WALK — a moved clients/ root, a bad
			// extension filter — and reports "looked at 0 source items".
			// `minFlagged` catches a dead DETECTOR: a healthy walk whose
			// container/reset regexes stopped matching. Today the walk sees
			// roughly 200 files and the detector flags 71.
			scannedCount: clientSourceFiles().length,
			minScanned: 100,
			minFlagged: 40,
			flagged: scanSessionStateCandidates().map((c) => c.file),
			registered: SESSION_STATE_REGISTRY.map((e) => e.module),
			exemptions: EXEMPT_SESSION_STATE_FILES,
			minReasonLength: 16,
			remediation:
				"Decide which it is. If the state must re-arm at session_start, " +
				"register it (and wire its reset into handleSessionStart). If it is a " +
				"host derivation, a config memo or turn-scoped working state, exempt it " +
				"with the reason.",
		});

	it("every session-state-shaped file is registered or exempted with a reason", () => {
		const { unaccounted, problems } = audit();
		if (unaccounted.length > 0) expect.fail(problems.join("\n\n"));
	});

	it("no exemption names a file the sweep no longer flags", () => {
		expect(audit().staleExemptions).toEqual([]);
	});

	it("every exemption carries a reason", () => {
		expect(audit().reasonlessExemptions).toEqual([]);
	});

	it("the sweep still flags files — an empty scan must fail, not read as clean", () => {
		const { flaggedCount, problems } = audit();
		expect(
			problems.filter((p) => p.includes("declared floor")),
			problems.join("\n"),
		).toEqual([]);
		expect(flaggedCount).toBeGreaterThanOrEqual(40);
	});

	it("the walk itself still finds source files — a dead walk fails separately (F4)", () => {
		// Distinct from the test above: that one proves the DETECTOR matches,
		// this one proves the WALK has something to look at. A moved clients/
		// root reds here and names the walk; a broken container regex reds there
		// and names the detector.
		expect(clientSourceFiles().length).toBeGreaterThanOrEqual(100);
		expect(audit().scannedCount).toBe(clientSourceFiles().length);
	});

	it("documents the heuristic's blind spots rather than claiming full coverage", () => {
		// The sweep is a floor. This asserts that the boundary stays written
		// down: a future edit that deletes the limits list has to notice it is
		// deleting the honesty, not just a comment.
		expect(SWEEP_HEURISTIC_LIMITS.length).toBeGreaterThanOrEqual(5);
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("closure");
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("no reset seam");
	});

	// #1817: file-granular coverage above cannot see a NEW stateful symbol
	// landing inside a file that already registered or exempted — the #1801
	// review F1 shape. This pins each flagged file's detected-symbol COUNT and
	// diffs it against a live scan every run, so a new (or removed) module-level
	// Map/Set/PathKeyedMap changes the file's id and reds as an unaccounted item.
	it("every flagged file's stateful-symbol count matches its pin (#1817)", () => {
		const counts: Record<string, number> = {};
		for (const candidate of scanSessionStateCandidates()) {
			counts[candidate.file] = candidate.containers.length;
		}
		const { problems } = auditSymbolCounts({
			sweepName: "session-state symbol-count pin",
			counts,
			pinned: SESSION_STATE_SYMBOL_COUNTS,
		});
		if (problems.length > 0) expect.fail(problems.join("\n\n"));
	});

	it("the symbol-count pin names every file the sweep currently flags", () => {
		// The pin table is only a backstop if it actually covers the flagged
		// population — an entry silently missing from SESSION_STATE_SYMBOL_COUNTS
		// would make that file's count invisible rather than pinned. Distinct
		// from the drift check above: that one proves the NUMBERS agree, this one
		// proves every flagged FILE has a number to agree with in the first place.
		const flaggedFiles = new Set(
			scanSessionStateCandidates().map((c) => c.file),
		);
		const missing = [...flaggedFiles].filter(
			(file) => !Object.hasOwn(SESSION_STATE_SYMBOL_COUNTS, file),
		);
		expect(missing, missing.join("\n")).toEqual([]);
	});

	// The mirror of the test above (review round 1, G1): a PIN row naming a
	// file the scan does NOT currently flag is silent dead weight — the pin's
	// key is folded into `auditSymbolCounts`'s composite id, so a phantom entry
	// never becomes an `unaccounted` item and `auditRegistry`'s `staleExemptions`
	// never fires either, because `auditSymbolCounts` never passes exemptions.
	// Nothing structurally catches a made-up filename without this test.
	it("every symbol-count pin entry names a file the sweep still flags — no phantom rows", () => {
		const flaggedFiles = new Set(
			scanSessionStateCandidates().map((c) => c.file),
		);
		const phantom = Object.keys(SESSION_STATE_SYMBOL_COUNTS).filter(
			(file) => !flaggedFiles.has(file),
		);
		expect(phantom, phantom.join("\n")).toEqual([]);
	});
});

// #1817: the symbol-count pin's own correctness, against a synthetic fixture
// tree rather than the real clients/ tree — so the regression cannot hide
// behind whatever clients/ happens to contain today, the same discipline the
// R1/S1 walker probes above use.
describe("session-state sweep — symbol-count pin regression (#1817)", () => {
	function withFixtureTree(
		files: Record<string, string>,
		run: (dir: string) => void,
	): void {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-state-symbol-pin-"),
		);
		try {
			for (const [name, contents] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), contents);
			}
			run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const REGISTERED_FILE_BEFORE = [
		"const existingLatch = new Map<string, string>();",
		"",
		"export function resetExistingLatch(): void {",
		"\texistingLatch.clear();",
		"}",
		"",
	].join("\n");

	// The #1801 F1 shape exactly: a SECOND, uncleared module-level Map added
	// inside a file that already carries a registered container + reset.
	const REGISTERED_FILE_AFTER = [
		REGISTERED_FILE_BEFORE,
		"const newUnclearedLatch = new Map<string, string>();",
		"",
	].join("\n");

	it("file-level coverage alone cannot see the new symbol landing in an already-registered file", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_AFTER },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				expect(candidates.map((c) => c.file)).toEqual([
					"already-registered.ts",
				]);
				expect(candidates[0].containers).toEqual([
					"existingLatch",
					"newUnclearedLatch",
				]);
				// This is the bug #1817 reports: the FILE is still registered, so a
				// file-granular audit reads clean even though a second, uncleared
				// latch landed inside it.
				const fileLevel = auditRegistry({
					sweepName: "fixture file-level audit",
					flagged: candidates.map((c) => c.file),
					registered: ["already-registered.ts"],
				});
				expect(fileLevel.problems).toEqual([]);
			},
		);
	});

	it("the symbol-count pin reds when a registered file's detected-symbol count drifts", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_AFTER },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;

				// Pin captured BEFORE the second latch landed — one container, as
				// REGISTERED_FILE_BEFORE has.
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					pinned: { "already-registered.ts": 1 },
				});
				expect(pinAudit.problems.length).toBeGreaterThan(0);
				expect(pinAudit.unaccounted).toEqual(["already-registered.ts@2"]);
			},
		);
	});

	it("the symbol-count pin passes when the live count matches the pin", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_BEFORE },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					pinned: { "already-registered.ts": 1 },
				});
				expect(pinAudit.problems).toEqual([]);
			},
		);
	});

	it("also reds when a symbol is REMOVED without updating the pin", () => {
		withFixtureTree(
			{ "already-registered.ts": REGISTERED_FILE_BEFORE },
			(dir) => {
				const candidates = scanSessionStateCandidates(dir);
				const counts: Record<string, number> = {};
				for (const c of candidates) counts[c.file] = c.containers.length;
				const pinAudit = auditSymbolCounts({
					sweepName: "fixture symbol-count audit",
					counts,
					// Pin still claims 2, as if a symbol had been removed without
					// updating the table.
					pinned: { "already-registered.ts": 2 },
				});
				expect(pinAudit.problems.length).toBeGreaterThan(0);
			},
		);
	});
});
