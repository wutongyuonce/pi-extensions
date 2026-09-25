/**
 * The population of `AnalysedRootSignal.analyzedFiles` PRODUCERS is pinned
 * (#3416).
 *
 * The recurrence this prevents, concretely: #3416 surveyed all nine
 * `lens_diagnostics mode=full` runners and recorded a per-member verdict that
 * none of the eight non-opengrep tools can supply a trustworthy admitted-file
 * set — each one's report names the files it reported FINDINGS for, never the
 * files its scan ADMITTED. That verdict is load-bearing, because a coverage set
 * derived from a findings-only report is worse than no set at all: `record()`
 * (`clients/project-diagnostics/fresh-fetch.ts`) pushes an
 * `authoritativeCoverage` entry on the DECLARATION, which hands that runner
 * FILE-level retirement authority, so a file that once had a finding and is now
 * clean drops out of the set and its retained finding is kept forever — where
 * the id-only fallback arm retires it today.
 *
 * A PR-body table cannot notice a SECOND client quietly assigning the field. This
 * test can. If it reds, the change is not necessarily wrong — it means #3416's
 * verdict table must be re-derived for the new producer (the three proofs the
 * issue names: the report field read from the tool's own source at a pinned
 * version, its path semantics against `realpathOrResolve`, and a captured-report
 * fixture for a tree with admitted AND excluded files) and this list updated in
 * the same PR.
 *
 * Deliberately NOT pinned here: the number of `record()` lanes. A new runner
 * that declares no coverage falls through the id-only arm and is safe by
 * construction; only a new PRODUCER can make an absent-coverage verdict
 * dishonest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	repoRoot,
	shippedContainerSourceRoots,
} from "../support/session-state-scan.js";
import {
	assertNonEmptyScan,
	codeMatches,
	listSourceFiles,
	readWalkedFiles,
} from "../support/sweep-kit.js";

/**
 * The recorded producer population from #3416's survey. Repo-relative posix
 * paths, sorted.
 */
const RECORDED_PRODUCERS = ["clients/opengrep-client.ts"] as const;

/**
 * An ASSIGNMENT of the field, in either shape JavaScript offers: an
 * object-literal property (`analyzedFiles: […]`) or a property write
 * (`result.analyzedFiles = […]`).
 *
 * `analyzedFiles?:` — the optional-property DECLARATION shape — cannot match
 * either alternative, which is what keeps the interface field
 * (`clients/analysed-root.ts`) and `record()`'s parameter type
 * (`clients/project-diagnostics/fresh-fetch.ts`) out of the population without
 * an allowlist naming them. Reads (`analysis.analyzedFiles.length`,
 * `analysis?.analyzedFiles !== undefined`) carry neither `:` nor `=` and are
 * likewise not matched. The `=` alternative excludes `==`/`===` so a comparison
 * is not read as a write.
 *
 * Known limit, stated rather than papered over: a producer that spreads the
 * field in from a variable built elsewhere (`...coverage`) is invisible to a
 * text scan. The literal key still has to be written somewhere for the array to
 * exist, so the population catches it at that site instead.
 */
const ASSIGNMENT = /\banalyzedFiles\s*(?::|=(?!=))/;

/** Repo-relative posix path, the form `RECORDED_PRODUCERS` uses. */
function repoRelative(absolute: string): string {
	return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

/** Every shipped `.ts` source file, tests and declarations excluded. */
function shippedSourceFiles(): string[] {
	return shippedContainerSourceRoots()
		.flatMap((root) =>
			fs.statSync(root).isDirectory()
				? listSourceFiles(root, { extensions: [".ts"], skipTests: true })
				: [root],
		)
		.sort();
}

describe("analyzedFiles producer coverage (#3416)", () => {
	it("pins the recorded set of analyzedFiles producers", () => {
		const files = shippedSourceFiles();
		// A walk that loses its population must fail, not read as clean
		// (AGENTS.md shape 10). Measured population on this head: 483 files, so a
		// floor of 300 leaves room for ordinary deletion without ever passing on a
		// walk that broke.
		assertNonEmptyScan("analyzedFiles producer sweep", files.length, 300);

		const producers = readWalkedFiles(files)
			// `codeMatches` filters to spans that are real code, so a COMMENT or a
			// string literal naming `analyzedFiles:` can neither add a producer nor
			// excuse one — the self-excuse direction AGENTS.md's "detectors match
			// code, not prose" screen names.
			.filter(({ source }) => codeMatches(source, ASSIGNMENT).length > 0)
			.map(({ file }) => repoRelative(file))
			.sort();

		expect(producers).toEqual([...RECORDED_PRODUCERS]);
	});
});
