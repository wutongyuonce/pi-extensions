/**
 * Governance for the `clients/turn-end/` lane modules (#1892).
 *
 * Extracting a turn-end delivery lane out of `clients/runtime-turn.ts` moves
 * code out from under two mechanisms that only read that one file, so this
 * suite walks the lane directory itself — it fires on any new or edited lane,
 * which a symbol grep structurally cannot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import { assertNonEmptyScan, listSourceFiles } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const LANE_DIR = path.join(REPO_ROOT, "clients/turn-end");

function laneSources(): Array<{ file: string; stripped: string }> {
	const files = listSourceFiles(LANE_DIR, { skipTests: true });
	// AGENTS.md shape 10 / the #1718 lesson: an empty sweep must fail rather
	// than read as clean. The floor is the interface plus one lane module.
	assertNonEmptyScan("turn-end lane modules", files.length, 2);
	return files.map((full) => ({
		file: path.relative(REPO_ROOT, full),
		stripped: stripCommentsAndStrings(fs.readFileSync(full, "utf8")),
	}));
}

/** The lane files, comment-and-string blanked so prose cannot satisfy a rule. */
const LANE_SOURCES = laneSources();

const TIER_PUSH_RE = /\b(blockerParts|staleSecretParts|advisoryParts)\.push\(/;
const GATE_CALL_RE = /\bgateFindingsByPathFreshness\(/;

describe("turn-end lane boundaries (#1892)", () => {
	// The population check: every rule below is vacuous against an empty
	// directory, so a lane tree that vanished (or moved) reds here first rather
	// than passing three rules over nothing (`assertNonEmptyScan` above fires
	// before any of them, at module load).
	it("finds the lane interface and at least one lane module", () => {
		const files = LANE_SOURCES.map((s) => s.file);
		expect(files).toContain("clients/turn-end/lane.ts");
		expect(
			files.filter((f) => f.startsWith("clients/turn-end/lanes/")).length,
		).toBeGreaterThan(0);
	});

	// Recurrence prevented: the `@delivery-surface:` seam scan in
	// `tests/clients/finding-delivery-gate.test.ts` reads exactly
	// `clients/runtime-turn.ts` and `tools/lens-diagnostics.ts`. A lane that
	// pushed its section straight into a tier from its own file would be an
	// agent-facing render seam that scan cannot see, so a new untagged,
	// unregistered delivery surface would ship green. Lanes RETURN parts
	// (`TurnEndLaneParts`); the composer owns the push.
	it("no lane pushes into a turn tier — the tag scan only reads the composer", () => {
		const offenders = LANE_SOURCES.filter((s) =>
			TIER_PUSH_RE.test(s.stripped),
		).map((s) => s.file);
		expect(offenders, offenders.join(", ")).toEqual([]);
	});

	// Recurrence prevented: #3264 folded the turn-end scanner stores into ONE
	// `gateFindingsByPathFreshness` call so a path two stores cite is stat'd
	// once, spends one stat budget, and writes one bounded decision record per
	// delivery instead of up to six. A lane that gated its own sources would
	// re-split that pass per lane the moment a second lane is extracted —
	// silently, since every individual lane would still look correct. Lanes
	// DECLARE sources from `collect`; the composer runs the one pass.
	it("no lane calls the freshness gate itself — the pass is per delivery", () => {
		const offenders = LANE_SOURCES.filter((s) =>
			GATE_CALL_RE.test(s.stripped),
		).map((s) => s.file);
		expect(offenders, offenders.join(", ")).toEqual([]);
	});
});
