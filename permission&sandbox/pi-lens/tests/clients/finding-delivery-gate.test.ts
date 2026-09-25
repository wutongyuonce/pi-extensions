/**
 * Coverage guard for the #1634 finding-delivery gate.
 *
 * Review round F1/F2 findings on the first version of this file:
 *   - F1: `expect(src).toContain(gateName)` matched the IMPORT line and a doc
 *     comment mentioning the gate by name — stubbing the three real gate
 *     calls to identity and deleting the age interpolations left the guard
 *     19/19 green.
 *   - F2: `DELIVERY_SURFACES` and `EXPECTED_SURFACE_IDS` were two hand lists
 *     that only checked each other — a brand-new ungated `advisoryParts.push`
 *     seam passed silently.
 *
 * Fix: (1) every gate/label claim is checked against a literal, comment/
 * string-STRIPPED `evidence` substring declared per surface (see
 * clients/finding-delivery-gate.ts's `DeliverySurfaceEntry.evidence` doc) —
 * chosen to be surface-specific so a stub of a DIFFERENT surface's call to
 * the same shared gate function cannot satisfy it. (2) `clients/runtime-turn.ts`
 * and `tools/lens-diagnostics.ts` are REALLY scanned for their render-seam
 * shapes (`blockerParts.push`/`advisoryParts.push`/`staleSecretParts.push`,
 * and `format*Mode` function definitions) and every seam found must carry an
 * `@delivery-surface: <id>` tag naming a real registry entry — an untagged
 * seam fails the suite, exactly the session-state sweep's "registered or
 * fail" pattern.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	assertNoDeliveryBypass,
	DELIVERY_SURFACES,
	formatCacheAgeLabel,
	type DeliverySurfaceEntry,
} from "../../clients/finding-delivery-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

function readSource(relativeFile: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
}

const sourceCache = new Map<string, string>();
function source(file: string): string {
	let cached = sourceCache.get(file);
	if (cached === undefined) {
		cached = readSource(file);
		sourceCache.set(file, cached);
	}
	return cached;
}

const EXPECTED_SURFACE_IDS = [
	"runtime-turn:secrets-gitleaks",
	"runtime-turn:secrets-trivy",
	"runtime-turn:govulncheck-advisory",
	"runtime-turn:unresolved-inline-blocker",
	"runtime-turn:stale-secrets-tier",
	"runtime-turn:trivy-critical-blocker",
	"runtime-turn:trivy-cve-advisory",
	"runtime-turn:trivy-license-advisory",
	"runtime-turn:dead-code-advisory",
	"runtime-turn:knip-blocker",
	"runtime-turn:knip-advisory",
	"runtime-turn:actionable-warnings-advisory",
	"runtime-turn:code-quality-warnings-advisory",
	"runtime-turn:disposition-suppressed-notice",
	"runtime-turn:late-auxiliary-findings",
	"runtime-turn:late-runner-findings",
	"runtime-turn:cascade-blocker",
	"runtime-turn:cascade-coverage-advisory",
	// #3102: the cold-neighbour cascade run's own build-time lane, a turn
	// earlier than the runtime-turn render that carries it.
	"cascade-format:resolved-found-run",
	// #3157: the IN-LANE cascade's four display sites, which never enter the
	// dispatcher's filter pipeline — a separate lane from the quiet-window run
	// above, and the one #3102's file-level sweep verdict cleared wrongly.
	"dispatch-integration:in-lane-cascade",
	"runtime-turn:call-graph-advisory",
	"lens-diagnostics:mode-full",
	"lens-diagnostics:mode-all",
	"lens-diagnostics:mode-delta",
	"widget-state:footer",
	"agent-nudge:context-message",
	"test-runner-delivery:custom-entry",
	"project-diagnostics:persisted-snapshot",
	// #2028: the remaining agent-facing surfaces.
	"tool-call:stop-blocker",
	"lsp-diagnostics:tool-output",
	"git-guard:commit-blocked",
	"read-guard-tool-lines:preflight-errors",
	"agent-behavior:thrashing-notice",
	"tool-call:duplicate-export-blocker",
	// #2423: the shape adapters promoted out of `read-guard-tool-lines.ts` carry
	// their blocking preflight text with them.
	"mutating-tool:adapter-preflight-errors",
	// #2007: the shared-checkout refusal, the same live-preflight shape as
	// `git-guard:commit-blocked`.
	"shared-checkout-guard:worktree-mutation-blocked",
].sort();

// ── Real seam scan (#1634 review F2) ────────────────────────────────────────
//
// `stripCommentsAndStrings` blanks comments/string contents IN PLACE (same
// line count, same column layout for anything left) — the same tool the
// session-state sweep uses to avoid mis-lexing a commented-out declaration as
// a real one. We reuse it here so a seam-shaped call inside a comment or a
// string literal (e.g. this very file's own doc comments) is never counted
// as a real seam, and a REAL seam hidden inside a template string is never
// missed either.

const TAG_RE = /@delivery-surface:\s*([\w:,-]+)/;

/** One call-shaped seam found in the STRIPPED source, 1-based line number. */
interface SeamHit {
	line: number;
	text: string;
}

function findSeams(strippedSource: string, pattern: RegExp): SeamHit[] {
	const lines = strippedSource.split("\n");
	const hits: SeamHit[] = [];
	lines.forEach((text, index) => {
		if (pattern.test(text)) hits.push({ line: index + 1, text: text.trim() });
	});
	return hits;
}

/**
 * For each seam hit, the tag binds to EXACTLY the immediately preceding
 * NON-BLANK raw line — no lookback window, no "nearest tag wins" (#1634
 * review round R1a: a 4-line lookback window let a NEW untagged seam
 * silently INHERIT the previous seam's tag — the most natural way someone
 * adds a new advisory without registering it: paste a second `push` call
 * right after an already-tagged one). Each tag LINE can bind at most one
 * seam — tracked in `consumedTagLines` — so two seams can never share one
 * tag comment.
 */
function tagsForSeams(
	rawSource: string,
	seams: SeamHit[],
): Array<{ seam: SeamHit; ids: string[] }> {
	const rawLines = rawSource.split("\n");
	const consumedTagLines = new Set<number>();
	return seams.map((seam) => {
		let i = seam.line - 2; // 0-based index of the raw line just above the seam
		while (i >= 0 && rawLines[i].trim() === "") i--;
		if (i < 0) return { seam, ids: [] };
		const m = TAG_RE.exec(rawLines[i]);
		if (!m || consumedTagLines.has(i)) return { seam, ids: [] };
		consumedTagLines.add(i);
		return { seam, ids: m[1].split(",").map((s) => s.trim()) };
	});
}

/** Every real seam in `rawSource`, paired with its (possibly empty) tag ids. */
function scanTaggedSeams(
	rawSource: string,
	seamPattern: RegExp,
): Array<{ seam: SeamHit; ids: string[] }> {
	const stripped = stripCommentsAndStrings(rawSource);
	const seams = findSeams(stripped, seamPattern);
	return tagsForSeams(rawSource, seams);
}

/**
 * Scanner entry point, exported so the red-proof tests below can run it
 * against a synthetic FIXTURE string (an untagged/mistagged mutant) without
 * touching the real repo files.
 */
function scanUntaggedOrMistaggedSeams(
	rawSource: string,
	seamPattern: RegExp,
	registryIds: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const { seam, ids } of scanTaggedSeams(rawSource, seamPattern)) {
		if (ids.length === 0) {
			problems.push(`line ${seam.line}: untagged seam — ${seam.text}`);
			continue;
		}
		for (const id of ids) {
			if (!registryIds.has(id)) {
				problems.push(
					`line ${seam.line}: tagged "${id}", which is not in DELIVERY_SURFACES — ${seam.text}`,
				);
			}
		}
	}
	return problems;
}

const RUNTIME_TURN_SEAM_PATTERN =
	/\b(blockerParts|advisoryParts|staleSecretParts)\.push\(/;
const LENS_DIAGNOSTICS_MODE_FN_PATTERN =
	/^(?:async\s+)?function\s+format\w*Mode\(/;

describe("finding-delivery-gate real seam scan (#1634 review F2)", () => {
	const registryIds = new Set(Object.keys(DELIVERY_SURFACES));

	it("every blockerParts/advisoryParts/staleSecretParts push in runtime-turn.ts is tagged and registered", () => {
		const problems = scanUntaggedOrMistaggedSeams(
			source("clients/runtime-turn.ts"),
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("every mode=<x> report function in lens-diagnostics.ts is tagged and registered", () => {
		const problems = scanUntaggedOrMistaggedSeams(
			source("tools/lens-diagnostics.ts"),
			LENS_DIAGNOSTICS_MODE_FN_PATTERN,
			registryIds,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("found at least one real seam in each scanned file (the scan itself is not a false negative)", () => {
		const runtimeTurnStripped = stripCommentsAndStrings(
			source("clients/runtime-turn.ts"),
		);
		const lensDiagStripped = stripCommentsAndStrings(
			source("tools/lens-diagnostics.ts"),
		);
		expect(
			findSeams(runtimeTurnStripped, RUNTIME_TURN_SEAM_PATTERN).length,
		).toBeGreaterThan(15);
		expect(
			findSeams(lensDiagStripped, LENS_DIAGNOSTICS_MODE_FN_PATTERN).length,
		).toBeGreaterThanOrEqual(3);
	});

	// RED PROOF (F2): reproduces the reviewer's exact mutant — a brand-new
	// ungated `advisoryParts.push` seam with no tag — against a FIXTURE, not
	// the real file, so this test's own correctness never depends on nobody
	// breaking the real file later.
	it("RED PROOF: a new untagged advisoryParts.push seam is flagged, not silently accepted", () => {
		const mutantSource = `
function handleTurnEnd() {
	// a brand-new surface nobody registered
	advisoryParts.push("some new finding with no freshness gate");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/untagged seam/);
	});

	it("RED PROOF: a tag naming an id absent from the registry is flagged", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:totally-made-up-id
	advisoryParts.push(report);
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/not in DELIVERY_SURFACES/);
	});

	it("RED PROOF: a seam-shaped call inside a COMMENT is not mistaken for a real seam", () => {
		// If the scanner didn't strip comments, this single-line comment would
		// register as an untagged seam and the test would fail even though
		// nothing here actually renders anything.
		const mutantSource = `
function handleTurnEnd() {
	// see also advisoryParts.push(x) in the sibling module for reference
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems).toEqual([]);
	});

	// RED PROOF (R1a): reproduces the reviewer's exact "proximity laundering"
	// probe — a second seam pasted right after an already-tagged one, with no
	// tag of its own, must NOT inherit the first seam's tag. This is the
	// natural way someone adds a new advisory: copy-paste an existing
	// `push` call and edit the message, leaving the tag comment where it was.
	it("RED PROOF: a second untagged seam right after a tagged one does not inherit its tag", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory
	advisoryParts.push("the real, registered finding");
	advisoryParts.push("a brand-new finding pasted right after it — unregistered");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBe(1);
		expect(problems[0]).toMatch(/untagged seam/);
		// Line 4 is the tagged (real) seam; line 5 is the untagged pasted-after
		// one — the failure must name line 5, not silently accept it via
		// inheritance from line 4's tag.
		expect(problems[0]).toContain("line 5:");
	});

	// RED PROOF (R1a): a blank-line gap between the tag and its seam still
	// binds correctly (blank lines are the only thing the lookback skips) —
	// and a SECOND seam after a blank gap does NOT reach back past the first
	// seam to re-use the same tag.
	it("RED PROOF: a tag cannot bind two seams even across a blank-line gap", () => {
		const mutantSource = `
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory

	advisoryParts.push("the real, registered finding");

	advisoryParts.push("a second finding, blank-line-separated, still unregistered");
}
`;
		const problems = scanUntaggedOrMistaggedSeams(
			mutantSource,
			RUNTIME_TURN_SEAM_PATTERN,
			registryIds,
		);
		expect(problems.length).toBe(1);
		// Line 5 is the tagged (real) seam; line 7 is the blank-separated
		// second seam, which must still be reported untagged on its own line.
		expect(problems[0]).toContain("line 7:");
	});
});

describe("finding-delivery-gate enumeration (#1634)", () => {
	it("registers exactly the surfaces enumerated from the render seams", () => {
		expect(Object.keys(DELIVERY_SURFACES).sort()).toEqual(EXPECTED_SURFACE_IDS);
	});

	it("every registered surface passes the no-bypass validator", () => {
		expect(() => assertNoDeliveryBypass()).not.toThrow();
	});

	it("RED PROOF: a surface with a third mode is rejected, not silently accepted", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			// Deliberately malformed for the red-proof. The @ts-expect-error sits
			// on the offending property, not on the object literal: a formatter
			// that wraps this literal across lines moves the reported error to
			// the `mode` line and turns an object-level directive into TS2578.
			"synthetic:bypass": {
				// @ts-expect-error "bypass" is not a valid delivery mode
				mode: "bypass",
				file: "nowhere.ts",
				description: "x",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:bypass/,
		);
	});

	it("RED PROOF: a gated surface that names zero gates is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:empty-gate": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: [],
				evidence: ["x"],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:empty-gate/,
		);
	});

	it("RED PROOF: a gated surface that names zero evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:no-evidence": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: ["someGate"],
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/names no evidence/,
		);
	});

	it("RED PROOF: a labeled surface missing reason/ageSource is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:bare-label": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "",
				ageSource: "",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:bare-label/,
		);
	});

	it("RED PROOF: a non-live labeled surface with no evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:label-no-evidence": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "SomeCache.scannedAt",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/names no evidence/,
		);
	});

	it("RED PROOF: status=partial with no partialReason is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:partial-no-reason": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "live",
				evidence: [],
				status: "partial",
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/status=partial/,
		);
	});
});

// ── Evidence ground-truth (#1634 review F1, R1b, R2) ────────────────────────
//
// For each surface with `evidence.length > 0`, every declared string must
// occur — as a literal substring of the COMMENT-stripped source (STRINGS are
// kept verbatim, unlike the seam scan above, since a surface's evidence is
// often itself a string/template argument like `store: "gitleaks"` or the
// interpolated `${trivyAgeLabel}` fragment) — at least `evidenceMin` times,
// WITHIN THE RIGHT SCOPE:
//
//   - R1b ("valid-tag laundering"): for a `clients/runtime-turn.ts` surface
//     with its own tagged seam(s), the scope is that seam's OWN region
//     (a bounded window around the tag), not the whole file. Checking the
//     whole file let an ungated seam tagged with an EXISTING gated id pass,
//     because that id's real evidence exists somewhere else entirely — this
//     ties the proof to the SPECIFIC seam the tag claims to cover.
//   - R2 ("identity-stub laundering"): for a `gated` surface, an evidence
//     occurrence must sit within a tight line window of a CALL-SHAPED
//     occurrence of one of its declared `gates` (`name(`) — not just the
//     argument literal, which survives swapping the callee for an identity
//     stub while leaving `store: "gitleaks"` untouched.
//
// `lens-diagnostics.ts`'s function-tagged surfaces and the two hand-
// registered surfaces (widget-state footer, agent-nudge) keep a whole-file
// scope: their evidence genuinely lives inside a helper function called from
// (not merely near) the tagged line, and there are only a handful of such
// surfaces, so a file-wide search doesn't have the runtime-turn.ts push-seam
// pattern's "many one-line entries" laundering risk R1b targets.

/** Blanks `//` and `/* *\/` comments IN PLACE (newlines preserved, so line
 * numbers / line count stay aligned with the raw source) — unlike
 * `stripCommentsAndStrings`, string/template CONTENTS are left untouched,
 * since a surface's evidence is often itself a string/template argument. */
function stripCommentsOnly(source: string): string {
	const out = source.split("");
	const blank = (i: number) => {
		if (out[i] !== "\n") out[i] = " ";
	};
	let i = 0;
	const n = source.length;
	while (i < n) {
		const c = source[i];
		const c2 = source[i + 1];
		if (c === "/" && c2 === "/") {
			while (i < n && source[i] !== "\n") {
				blank(i);
				i++;
			}
			continue;
		}
		if (c === "/" && c2 === "*") {
			blank(i);
			blank(i + 1);
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
				blank(i);
				i++;
			}
			if (i < n) {
				blank(i);
				blank(i + 1);
				i += 2;
			}
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i++;
			while (i < n && source[i] !== quote) {
				i += source[i] === "\\" ? 2 : 1;
			}
			if (i < n) i++;
			continue;
		}
		i++;
	}
	return out.join("");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** 0-based line indexes in `lines` where `needle` occurs. */
function findLineIndexes(lines: string[], needle: string): number[] {
	const out: number[] = [];
	lines.forEach((l, i) => {
		if (l.includes(needle)) out.push(i);
	});
	return out;
}

/**
 * True when some line within `proximity` of `lineIdx` (0-based) contains a
 * call-shaped occurrence of `calleeName` — R2's defense: the evidence
 * ARGUMENT alone (e.g. `store: "gitleaks"`) survives an identity-stubbed
 * callee; requiring the callee within a tight window of that SPECIFIC
 * argument occurrence is what a stub cannot fake without un-stubbing.
 */
function hasNearbyCallSite(
	lines: string[],
	lineIdx: number,
	calleeName: string,
	proximity: number,
): boolean {
	const start = Math.max(0, lineIdx - proximity);
	const end = Math.min(lines.length, lineIdx + proximity + 1);
	for (let i = start; i < end; i++) {
		if (lines[i].includes(`${calleeName}(`)) return true;
	}
	return false;
}

const REGION_BACK_WINDOW = 150;
const REGION_FORWARD_WINDOW = 10;
const CALLEE_PROXIMITY_LINES = 3;
const BINDING_CHAIN_HOPS = 3;

/** Leading identifier of an argument-shaped needle: `gitleaksGate.live,` → `gitleaksGate`. */
function rootIdentifier(text: string): string | undefined {
	return /^[A-Za-z_$][\w$]*/.exec(text.trim())?.[0];
}

/**
 * EVERY `const <ident> = …` line in the file that binds `ident`.
 *
 * #3264 review F1: taking the FIRST match ignores lexical scope, so an outer
 * gate-bound name shadowed by an inner hand-built object laundered through it.
 * Round 2 answered that by rejecting any duplicated name outright, and the
 * verify round found the false negative that creates: a nested function or block
 * may legitimately bind its OWN gate result under the same name, and rejecting
 * that reds code which is correctly gated — the opposite of this detector's
 * contract (#3264 verify F1-A).
 *
 * So the candidates are all returned and `identifierReachesGate` requires EVERY
 * one of them to reach a gate. Whichever binding the use site meant, the arm
 * came from a gate; one ungated candidate and it is laundering again. This is
 * deliberately not resolve-by-brace-depth: a brace walk over
 * `stripCommentsOnly` text counts braces inside string literals too (this
 * file's own fixtures contain them), so it would be a second, fool-able parser
 * deciding a security question.
 */
function bindingLinesOf(lines: string[], ident: string): number[] {
	const re = new RegExp(`\\bconst\\b[^=]*\\b${ident}\\b[^=]*=`);
	const found: number[] = [];
	for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push(i);
	return found;
}

/**
 * Does every declaration of `ident` reach a call-shaped gate, directly through
 * its own initializer or through a bounded chain of aliases?
 */
function identifierReachesGate(
	lines: string[],
	ident: string,
	gates: readonly string[],
	hopsLeft: number,
): boolean {
	if (hopsLeft <= 0) return false;
	const declarations = bindingLinesOf(lines, ident);
	if (declarations.length === 0) return false;
	return declarations.every((declaration) => {
		if (bindingRhsIsGateCall(lines, declaration, gates)) return true;
		const line = lines[declaration];
		const next = rootIdentifier(line.slice(line.indexOf("=") + 1));
		return (
			next !== undefined &&
			identifierReachesGate(lines, next, gates, hopsLeft - 1)
		);
	});
}

/**
 * R2, generalized for a gate call SHARED by several stores (#1892). A surface
 * that renders one ARM of such a call (`gitleaksGate.live,`) cannot be
 * textually adjacent to `gateFindingsByPathFreshness(` — the other stores'
 * sources sit between them. So follow the `const` binding chain from the arm
 * back to the call, at most `BINDING_CHAIN_HOPS` hops.
 *
 * The identity-stub guarantee is unchanged, and that is the point: an arm read
 * bound to anything that is not a call-shaped gate — an identity stub, a
 * hand-built `{ live, stale }` object — still reds. Only the ROUTE from
 * evidence to gate got longer, never the set of things that count as a gate.
 *
 * #3264 review F1 sharpened two halves of that route. A binding is certified by
 * its OWN right-hand side (`bindingRhsIsGateCall`), never by a gate call that
 * merely sits within three lines of it — otherwise a hand-built object declared
 * just below a real gate call inherits its certification. And a name the file
 * declares more than once is certified only when EVERY declaration reaches a
 * gate (`identifierReachesGate`) — otherwise a distant outer binding certifies
 * an inner shadow, while a nested scope that legitimately re-binds its own gate
 * result under the same name is still accepted (#3264 verify F1-A).
 * #3266: proximity only selects a call-shaped gate to inspect; it never
 * certifies an unrelated occurrence before this binding check runs.
 */
function evidenceReachesGateCall(
	lines: string[],
	occurrenceIdx: number,
	needle: string,
	gates: readonly string[],
): boolean {
	const inlineGateResult = (idx: number) =>
		gates.some((gate) => {
			const line = lines[idx] ?? "";
			const callStart = line.indexOf(`${gate}(`);
			const occurrenceStart = line.indexOf(needle);
			if (callStart < 0 || occurrenceStart <= callStart) return false;
			return /\)\s*(?:\?\.|\.)\s*$/.test(
				line.slice(callStart + gate.length + 1, occurrenceStart),
			);
		});
	if (inlineGateResult(occurrenceIdx)) return true;
	const ident = rootIdentifier(needle);
	// #3266: an arm occurrence must use its own binding chain; a nearby gate
	// cannot certify it. Non-identifier evidence is a call-site label rather
	// than an arm read, so retain its existing nearby-call proof.
	if (ident !== undefined) {
		return identifierReachesGate(lines, ident, gates, BINDING_CHAIN_HOPS);
	}
	return gates.some((gate) =>
		hasNearbyCallSite(lines, occurrenceIdx, gate, CALLEE_PROXIMITY_LINES),
	);
}

/**
 * Is the gate call this binding's OWN initializer? Proximity is not enough: a
 * hand-built `{ live, stale }` object declared three lines under a real gate
 * call would otherwise inherit its certification (#3264 review F1's instance).
 * A wrapped assignment (`const { x } =` with the call on the following line) is
 * the one continuation accepted, because that is how the formatter breaks it.
 */
function bindingRhsIsGateCall(
	lines: string[],
	bound: number,
	gates: readonly string[],
): boolean {
	const hasGate = (text: string) =>
		gates.some((gate) => text.includes(`${gate}(`));
	const rhs = lines[bound].slice(lines[bound].indexOf("=") + 1);
	if (hasGate(rhs)) return true;
	if (rhs.trim() !== "") return false;
	for (let i = bound + 1; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		return hasGate(lines[i]);
	}
	return false;
}

/** 1-based line numbers in `strippedWholeSource` where `needle` occurs. */
function occurrenceLinesOf(
	strippedWholeSource: string,
	needle: string,
): number[] {
	const out: number[] = [];
	strippedWholeSource.split("\n").forEach((l, i) => {
		if (l.includes(needle)) out.push(i + 1);
	});
	return out;
}

/**
 * Nearest-neighbor, EXCLUSIVE assignment of evidence occurrences to the
 * seams competing for them (#1634 review round R1c — "close-range
 * laundering": a rogue seam placed INSIDE a real gate's lookback window,
 * closer than or comparable to the legitimate seam, used to pass just by
 * existing in the same window as the real evidence — the per-region check
 * asked "is evidence somewhere in MY window", not "is this evidence actually
 * MINE and nobody else's").
 *
 * Only seams tagged with the SAME id compete in one call — a DIFFERENT id's
 * seam legitimately reusing the identical call (e.g. `stale-secrets-tier`
 * reusing `secrets-gitleaks`'s gate) runs its OWN assignment and never
 * competes here, so sharing across ids stays intact.
 *
 * Candidates are (seam, occurrence) pairs within the lookback/lookahead
 * window, sorted by ascending distance; greedy assignment takes the closest
 * pair first and removes both sides from the pool — standard greedy nearest-
 * neighbor matching. A seam left without a claim failed to prove ITS OWN
 * evidence, even when some other (closer) seam of the same id legitimately
 * claimed the one real occurrence — which is exactly the outcome we want
 * when two same-id seams compete for evidence only one of them should have.
 */
function assignNearestExclusive(
	seamLines: number[],
	occurrenceLines: number[],
	back: number,
	forward: number,
	capacity: number,
): Map<number, number> {
	const pairs: Array<{ seamLine: number; occLine: number; dist: number }> = [];
	for (const seamLine of seamLines) {
		for (const occLine of occurrenceLines) {
			if (occLine >= seamLine - back && occLine <= seamLine + forward) {
				pairs.push({ seamLine, occLine, dist: Math.abs(seamLine - occLine) });
			}
		}
	}
	pairs.sort((a, b) => a.dist - b.dist);
	const occClaimCount = new Map<number, number>();
	const claimedSeam = new Set<number>();
	const assignment = new Map<number, number>();
	for (const p of pairs) {
		if (claimedSeam.has(p.seamLine)) continue;
		const used = occClaimCount.get(p.occLine) ?? 0;
		if (used >= capacity) continue;
		occClaimCount.set(p.occLine, used + 1);
		claimedSeam.add(p.seamLine);
		assignment.set(p.seamLine, p.occLine);
	}
	return assignment;
}

/**
 * Checks one `clients/runtime-turn.ts` surface's evidence via exclusive
 * nearest-neighbor assignment against ALL of that file's tagged seams (not
 * just the ones tagged with `id` — every seam is a potential COMPETITOR for
 * an occurrence). Returns problem strings, empty when every seam tagged
 * with `id` claimed every needle.
 */
function checkRuntimeTurnSeamEvidenceExclusive(
	id: string,
	entry: DeliverySurfaceEntry,
	allTaggedSeams: Array<{ seam: SeamHit; ids: string[] }>,
	wholeStrippedLines: string[],
): string[] {
	const problems: string[] = [];
	const seamsForId = allTaggedSeams
		.filter(({ ids }) => ids.includes(id))
		.map(({ seam }) => seam.line);
	if (seamsForId.length === 0) return problems;
	// Per-occurrence claim capacity — see `evidenceMin`'s doc in
	// clients/finding-delivery-gate.ts. Default 1 (one seam per occurrence);
	// a surface with N legitimate seams sharing one upstream call sets
	// evidenceMin: N so all N can claim it without contesting each other.
	const capacity = entry.evidenceMin ?? 1;
	const wholeStripped = wholeStrippedLines.join("\n");
	for (const needle of entry.evidence) {
		const occurrenceLines = occurrenceLinesOf(wholeStripped, needle);
		const assignment = assignNearestExclusive(
			seamsForId,
			occurrenceLines,
			REGION_BACK_WINDOW,
			REGION_FORWARD_WINDOW,
			capacity,
		);
		for (const seamLine of seamsForId) {
			const claimed = assignment.get(seamLine);
			if (claimed === undefined) {
				problems.push(
					`"${id}": the seam at line ${seamLine} could not exclusively claim an occurrence of ` +
						`"${needle}" within ${REGION_BACK_WINDOW}/${REGION_FORWARD_WINDOW} lines — either no ` +
						`occurrence is that close, or a competing seam claimed the nearest one first`,
				);
				continue;
			}
			// R2 applies only to ARGUMENT-shaped evidence (no "(" of its own) —
			// a needle that's already call-shaped (e.g. "applyDeltaFreshnessGate(")
			// is its own callee proof.
			if (entry.mode === "gated" && !needle.includes("(")) {
				const satisfied = evidenceReachesGateCall(
					wholeStrippedLines,
					claimed - 1,
					needle,
					entry.gates,
				);
				if (!satisfied) {
					problems.push(
						`"${id}": the occurrence of "${needle}" claimed by the seam at line ${seamLine} ` +
							`(line ${claimed}) is not within ${CALLEE_PROXIMITY_LINES} lines of a call-shaped ` +
							`${entry.gates.join("/")}( — possible identity-stub`,
					);
				}
			}
		}
	}
	return problems;
}

/**
 * Whole-file evidence check for surfaces with no push/function seam scan of
 * their own (`widget-state.ts`, `agent-nudge.ts`) and for the
 * `tools/lens-diagnostics.ts` function-tagged surfaces, where the evidence
 * genuinely lives inside a HELPER function called from the tagged line, not
 * necessarily near it — see the module doc above for why those keep a
 * whole-file scope instead of R1c's seam-exclusive assignment.
 */
function checkEvidenceInScope(
	id: string,
	entry: DeliverySurfaceEntry,
	scopeRawLines: string[],
	scopeLabel: string,
): string[] {
	const problems: string[] = [];
	const scopeStripped = stripCommentsOnly(scopeRawLines.join("\n"));
	const scopeStrippedLines = scopeStripped.split("\n");
	const min = entry.evidenceMin ?? 1;
	for (const needle of entry.evidence) {
		const count = countOccurrences(scopeStripped, needle);
		if (count < min) {
			problems.push(
				`"${id}": expected ${scopeLabel} to contain "${needle}" at least ${min}x (comment-stripped), found ${count}`,
			);
			continue;
		}
		if (entry.mode === "gated" && !needle.includes("(")) {
			const occurrenceLines = findLineIndexes(scopeStrippedLines, needle);
			const satisfied = occurrenceLines.some((lineIdx) =>
				entry.gates.some((gate) =>
					hasNearbyCallSite(
						scopeStrippedLines,
						lineIdx,
						gate,
						CALLEE_PROXIMITY_LINES,
					),
				),
			);
			if (!satisfied) {
				problems.push(
					`"${id}": expected "${needle}" to sit within ${CALLEE_PROXIMITY_LINES} lines of ` +
						`a call-shaped ${entry.gates.join("/")}( in ${scopeLabel} — found the argument ` +
						`but not the callee (possible identity-stub)`,
				);
			}
		}
	}
	return problems;
}

describe("finding-delivery-gate evidence ground-truth (#1634 review F1/R1b/R1c/R2)", () => {
	const runtimeTurnRaw = source("clients/runtime-turn.ts");
	const runtimeTurnStrippedLines =
		stripCommentsOnly(runtimeTurnRaw).split("\n");
	const allRuntimeTurnSeams = scanTaggedSeams(
		runtimeTurnRaw,
		RUNTIME_TURN_SEAM_PATTERN,
	);

	for (const [id, entry] of Object.entries(DELIVERY_SURFACES)) {
		if (entry.evidence.length === 0) continue;
		const isRuntimeTurn = entry.file === "clients/runtime-turn.ts";

		it(
			isRuntimeTurn
				? `"${id}" evidence is exclusively claimed by its own tagged seam(s) (R1b/R1c/R2)`
				: `"${id}" evidence is present in ${entry.file} (comments stripped)`,
			() => {
				const problems = isRuntimeTurn
					? checkRuntimeTurnSeamEvidenceExclusive(
							id,
							entry,
							allRuntimeTurnSeams,
							runtimeTurnStrippedLines,
						)
					: checkEvidenceInScope(
							id,
							entry,
							source(entry.file).split("\n"),
							entry.file,
						);
				expect(problems, problems.join("\n")).toEqual([]);
			},
		);
	}

	// Explicit, named proof that exclusivity is scoped PER ID, not global —
	// two DIFFERENT ids legitimately sharing the SAME gate call (the render
	// for `stale-secrets-tier` reuses `secrets-gitleaks`'s/`secrets-trivy`'s
	// gate output) must BOTH still pass; they are never competitors of each
	// other since each runs its own `assignNearestExclusive` call.
	it("shared-gate surfaces (secrets-gitleaks + stale-secrets-tier) both pass — exclusivity does not cross ids", () => {
		const gitleaksProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		const trivyProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-trivy",
			DELIVERY_SURFACES["runtime-turn:secrets-trivy"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		const staleTierProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:stale-secrets-tier",
			DELIVERY_SURFACES["runtime-turn:stale-secrets-tier"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		expect(gitleaksProblems, gitleaksProblems.join("\n")).toEqual([]);
		expect(trivyProblems, trivyProblems.join("\n")).toEqual([]);
		expect(staleTierProblems, staleTierProblems.join("\n")).toEqual([]);
	});

	// RED PROOF (F1): the reviewer's exact stub — the real evidence-bearing
	// code is gone, but a DOC COMMENT still mentions the gate's name with an
	// open paren, e.g. "the code calls gateFindingsByPathFreshness(...) here".
	// Against a fixture: strip-then-search must NOT find it.
	it("RED PROOF: a stub that removes the real call but keeps a comment mention is caught", () => {
		const stubbedFixture = `
// this surface used to call formatCacheAgeLabel(scannedAt) but no longer does
const trivyAgeLabel = "";
let report = "CRITICAL dependency CVEs (trivy). Upgrade before shipping:\\n";
`;
		const strippedFixture = stripCommentsOnly(stubbedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBe(0);
	});

	it("control: the SAME evidence string is found once real interpolation is present", () => {
		const fixedFixture = `
const trivyAgeLabel = formatCacheAgeLabel(scannedAt);
let report = \`CRITICAL dependency CVEs (trivy, \${trivyAgeLabel}). Upgrade before shipping:\\n\`;
`;
		const strippedFixture = stripCommentsOnly(fixedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBeGreaterThanOrEqual(
			1,
		);
	});

	// RED PROOF (R1b, far case): an ungated seam tagged with a real id, FAR
	// (beyond the lookback window) from that id's real evidence, must still
	// be caught — no candidate pair exists at all.
	it("RED PROOF (far): a rogue seam tagged with a real id, beyond the lookback window, is caught", () => {
		const filler = Array.from(
			{ length: REGION_BACK_WINDOW + 20 },
			(_, i) => `// filler ${i}`,
		);
		const rogueLines = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			...filler,
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("a rogue finding wearing a real tag, far away");',
		];
		const rogueSource = rogueLines.join("\n");
		const strippedLines = stripCommentsOnly(rogueSource).split("\n");
		const seams = scanTaggedSeams(rogueSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	// RED PROOF (R1c, NEAR case — review round R1c's actual finding): a rogue
	// seam placed INSIDE the lookback window, closer to the real evidence
	// than the legitimate seam is, must still be caught — the per-region
	// check (round 3's shipped fix) passed this exact shape, because both the
	// rogue seam's OWN window and the real seam's OWN window each
	// independently contained the one real occurrence. Exclusive assignment
	// gives the occurrence to whichever seam is closer and leaves the OTHER
	// seam — real or rogue — unsatisfied, so the overall check still reds
	// whenever two same-id seams compete for one occurrence.
	it("RED PROOF (near): a rogue seam placed CLOSER than the real seam to the same evidence is caught", () => {
		const realGateLines = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
		];
		const spacer = (n: number) =>
			Array.from({ length: n }, (_, i) => `// spacer ${i}`);
		const rogueLines = [
			...realGateLines,
			...spacer(69), // rogue sits 69 lines from the real gate — inside the window
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("a rogue finding, CLOSER to the real gate than the legit seam");',
			...spacer(29), // the "legitimate" seam sits further still (98 lines total)
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("the finding that would have been the real one");',
		];
		const rogueSource = rogueLines.join("\n");
		const strippedLines = stripCommentsOnly(rogueSource).split("\n");
		const seams = scanTaggedSeams(rogueSource, RUNTIME_TURN_SEAM_PATTERN);
		expect(seams.length).toBe(2); // sanity: both seams parsed and tagged
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		// Exactly one of the two same-id seams wins the single real occurrence;
		// the other is left unsatisfied — the check must red either way.
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	// RED PROOF (R2): "identity-stub laundering" — the reviewer's exact
	// mutant: keep `store: "gitleaks"` (the argument) but replace the callee
	// `gateFindingsByPathFreshness` with an identity stub. The argument
	// literal alone must NOT satisfy a `gated` surface's evidence.
	it("RED PROOF: identity-stubbing the callee while keeping the argument literal is caught", () => {
		const stubbedSource = [
			"function identityStub(x) { return x; }",
			"const scannerGates = identityStub({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(stubbedSource).split("\n");
		const seams = scanTaggedSeams(stubbedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#1892): the binding chain must not become a laundering route.
	// The recurrence it prevents: the scanner lanes now render ARMS of one
	// shared gate call, so evidence like `gitleaksGate.live,` is several hops
	// from `gateFindingsByPathFreshness(`. A surface that hand-builds the same
	// arm shape and skips the gate entirely — exactly what a future edit
	// "simplifying" the fold would produce — must still red.
	it("RED PROOF: an arm read bound to a hand-built object, never to the gate, is caught", () => {
		const ungatedSource = [
			"const scannerGates = { gitleaks: { live: rawFindings, stale: [] } };",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(ungatedSource).split("\n");
		const seams = scanTaggedSeams(ungatedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#3266): proximity is evidence for which call to inspect, not
	// certification. A no-spacer hand-built shadow beside an unrelated gate
	// must not inherit that call's identity.
	it("RED PROOF (#3266): a no-spacer hand-built arm cannot borrow a nearby gate", () => {
		const shadowedSource = [
			"const unrelatedGate = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = { live: rawFindings, stale: [] };",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(shadowedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("control (#3266): an arm near its own gate call remains accepted", () => {
		const ownGateSource = [
			"const gitleaksGate = gateFindingsByPathFreshness({ sources: {} });",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(ownGateSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(ownGateSource).split("\n"),
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	// RED PROOF (#3264 review F1): the binding chain must resolve the identifier
	// the USE SITE means, not the first one in the file. An outer gate-bound name
	// shadowed by an inner hand-built object used to launder: the detector
	// resolved the inner `outerArms` to the outer gate call and accepted an arm
	// that never passed through a gate.
	it("RED PROOF: a shadowed hand-built arm does not launder through an outer gate binding", () => {
		const shadowedSource = [
			"const outerArms = gateFindingsByPathFreshness({ sources: {} });",
			"{",
			"  const outerArms = { gitleaks: { live: raw, stale: [] } };",
			"  const gitleaksGate = outerArms.gitleaks;",
			"  const keptLive = filterFindingsByDisposition(",
			"    gitleaksGate,",
			"  );",
			"  // @delivery-surface: runtime-turn:secrets-gitleaks",
			'  advisoryParts.push("finding");',
			"}",
		].join("\n");
		const strippedLines = stripCommentsOnly(shadowedSource).split("\n");
		const seams = scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#3264 review F1, distant case): the shadow does not have to be
	// near the real gate call. Reject-on-ambiguity is what catches this one —
	// `bindingRhsIsGateCall` alone would happily certify the outer binding.
	it("RED PROOF: a shadow far from the real gate call does not launder either", () => {
		const spacer = Array.from({ length: 40 }, (_, i) => `// spacer ${i}`);
		const shadowedSource = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			...spacer,
			"const scannerGates = { gitleaks: { live: raw, stale: [] } };",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(shadowedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	const spacer = (n: number) =>
		Array.from({ length: n }, (_, i) => `  // shadow spacer ${i}`);

	// #3264 verify F1-A: reject-on-ambiguity must not red code that IS gated.
	// A nested function, or a block, may legitimately bind its own gate result
	// under the same name as an outer one — both initializers are gate calls, so
	// whichever binding the use site means, the arm came from a gate.
	it("control: a same-name shadow whose every declaration is a gate call is accepted", () => {
		// The spacers are load-bearing: without them the arm read sits within
		// `CALLEE_PROXIMITY_LINES` of the INNER gate call and the occurrence-level
		// check accepts it before the binding chain is ever consulted, so the
		// fixture would pass for a reason that has nothing to do with F1-A.
		const shadowedGateSource = (open: string) =>
			[
				"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
				open,
				"  const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
				...spacer(10),
				"  const gitleaksGate = scannerGates.gitleaks;",
				...spacer(10),
				"  const keptLive = filterFindingsByDisposition(",
				"    gitleaksGate,",
				"  );",
				"  // @delivery-surface: runtime-turn:secrets-gitleaks",
				'  advisoryParts.push("finding");',
				"}",
			].join("\n");
		const nestedFunction = shadowedGateSource("function nested() {");
		const nestedBlock = shadowedGateSource("{");
		for (const source of [nestedFunction, nestedBlock]) {
			const problems = checkRuntimeTurnSeamEvidenceExclusive(
				"runtime-turn:secrets-gitleaks",
				DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
				scanTaggedSeams(source, RUNTIME_TURN_SEAM_PATTERN),
				stripCommentsOnly(source).split("\n"),
			);
			expect(problems, problems.join("\n")).toEqual([]);
		}
	});

	// The other half of F1-A's refinement: "every declaration is a gate call" is
	// the accepting condition, so a duplicate where ONE declaration is
	// hand-built is still laundering — the detector cannot tell which binding
	// the use site meant, and one of the candidates never saw a gate.
	it("RED PROOF: a duplicated name is rejected when any one declaration is not gated", () => {
		const mixedSource = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"function nested() {",
			"  const scannerGates = { gitleaks: { live: raw, stale: [] } };",
			...spacer(10),
			"  const gitleaksGate = scannerGates.gitleaks;",
			...spacer(10),
			"  const keptLive = filterFindingsByDisposition(",
			"    gitleaksGate,",
			"  );",
			"  // @delivery-surface: runtime-turn:secrets-gitleaks",
			'  advisoryParts.push("finding");',
			"}",
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(mixedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(mixedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("control: a two-hop alias and a destructuring rename both still resolve to the gate", () => {
		const aliasSource = [
			"const scannerGates = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const renameSource = [
			"const { gitleaks: gitleaksGate } = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		for (const source of [aliasSource, renameSource]) {
			const problems = checkRuntimeTurnSeamEvidenceExclusive(
				"runtime-turn:secrets-gitleaks",
				DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
				scanTaggedSeams(source, RUNTIME_TURN_SEAM_PATTERN),
				stripCommentsOnly(source).split("\n"),
			);
			expect(problems, problems.join("\n")).toEqual([]);
		}
	});

	it("RED PROOF (#3266): a cyclic alias terminates and is rejected", () => {
		const cyclicSource = [
			"const gitleaksGate = scannerGates;",
			"const scannerGates = gitleaksGate;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(cyclicSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(cyclicSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
	});

	it("control (#3266): an inline gate result on the same line is accepted", () => {
		const inlineSource = [
			"const keptLive = filterFindingsByDisposition(gateFindingsByPathFreshness({}).gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(inlineSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(inlineSource).split("\n"),
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("control: the real (un-stubbed) call site satisfies both the argument and the callee-proximity check", () => {
		const realSource = [
			"const scannerGates = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(realSource).split("\n");
		const seams = scanTaggedSeams(realSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems).toEqual([]);
	});
});

describe("formatCacheAgeLabel (#1634)", () => {
	it("renders a whole-minute age for a recent scan", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 12, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 12m ago");
	});

	it("renders an exact-hour age past 60 minutes", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 4, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 0, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 3h ago");
	});

	// F5: a naive Math.round(minutes / 60) reported "1h" at 89 minutes.
	it("does not round UP to the next hour before the hour is complete (F5)", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 8, 29, 0); // 89 minutes later
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 1h 29m ago");
	});

	it("degrades to an honest unknown label on an empty/unparseable timestamp", () => {
		expect(formatCacheAgeLabel("")).toBe("scan age unknown");
		expect(formatCacheAgeLabel(undefined)).toBe("scan age unknown");
		expect(formatCacheAgeLabel("not-a-date")).toBe("scan age unknown");
	});

	it("never reports a negative age on clock skew", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 6, 59, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned <1m ago");
	});
});
