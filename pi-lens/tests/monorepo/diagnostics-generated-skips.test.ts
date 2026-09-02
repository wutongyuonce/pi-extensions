/**
 * #1107 phase 2 item 2 — tool-facing surfacing of the generated-name walk
 * skip counters.
 *
 * Phase 1 (#1111) added `generatedOrArtifactSkips`/`buildArtifactSkips` on
 * `SourceCollectionResult` plus a `latency.log` rollup, but nothing outside
 * that log line told a user/agent "N files were excluded by the
 * generated-name heuristic" — the exact tool-facing observability the issue
 * asked for. This mirrors `diagnostics-truncation.test.ts`'s #784 pattern
 * (scanTruncated -> scanTruncationNotice):
 *   1. `scanProjectDiagnostics` (`project-diagnostics/scanner.ts`) threads
 *      `SourceCollectionResult.generatedOrArtifactSkips`/
 *      `generatedNameOnlySkips`/`generatedDirSkips` into
 *      `ProjectDiagnosticsSnapshot`.
 *   2. `lens-engine.ts`'s `generatedSkipNotice` renders a one-line notice.
 *
 * Review round 2 (P1, empirically proven): the notice must NOT key off the
 * raw `generatedFileSkips` total — that counts STRONG evidence (lockfiles,
 * declaration files, minified/bundle output) and content/header-CONFIRMED
 * matches too, both of which are expected on virtually every real repo. A
 * repo with nothing more unusual than a `package-lock.json` and an ambient
 * `.d.ts` used to show "2 file(s) excluded by generated-name heuristics" on
 * every single scan, forever. The notice now keys off `generatedNameOnlySkips`
 * — the narrower, genuinely at-risk bucket (a WEAK name match trusted with NO
 * corroborating evidence at all) — plus `generatedDirSkips` (directory
 * pruning has no escape hatch, so it stays a genuine unverified-content
 * signal). The lockfile+.d.ts test below is the regression proof for the
 * fix; the directory test is the retained "does trigger" case.
 */

import { describe, expect, it } from "vitest";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import { generatedSkipNotice } from "../../clients/lens-engine.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

describe("project-diagnostics generated-name skip surfacing (#1107 phase 2)", () => {
	it("generatedFileSkips/generatedDirSkips are absent on a scan with nothing excluded", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: { "src/index.ts": "export const v = 1;\n" },
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedFileSkips).toBeUndefined();
			expect(snapshot.generatedNameOnlySkips).toBeUndefined();
			expect(snapshot.generatedDirSkips).toBeUndefined();
			expect(generatedSkipNotice(snapshot)).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});

	// #1107 phase 2 review round 2 (P1, empirically proven) — the regression
	// proof: a lockfile + an ambient declaration file are BOTH STRONG-evidence
	// skips that occur on almost every real repo. Pre-fix, this fixture's
	// `generatedFileSkips: 2` alone drove the notice on every scan, forever.
	// Post-fix, `generatedNameOnlySkips` stays unset (neither skip is a
	// name-only/unconfirmed match) so the notice is silent — the raw total is
	// still observable via `generatedFileSkips` for anyone who wants it, but
	// it no longer drives the user-facing notice.
	it("fixed (review round 2): a lockfile + ambient .d.ts alone do NOT trigger the notice, even though generatedFileSkips is nonzero", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"ambient.d.ts": "declare const globalThing: string;\n",
			},
			// makeMonorepo already writes a package.json per package; add a
			// lockfile alongside it to exercise the STRONG lockfile-name skip.
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const fs = await import("node:fs");
			const path = await import("node:path");
			fs.writeFileSync(
				path.join(repo.root, "packages", "a", "package-lock.json"),
				JSON.stringify({ name: "@scope/a", lockfileVersion: 3 }),
			);
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			// Both the lockfile and the ambient .d.ts were skipped (STRONG
			// evidence) — the raw total reflects that...
			expect(snapshot.generatedFileSkips).toBeGreaterThanOrEqual(2);
			// ...but neither is an unconfirmed name-only match, so the at-risk
			// counter — and therefore the notice — stays silent.
			expect(snapshot.generatedNameOnlySkips).toBeUndefined();
			expect(generatedSkipNotice(snapshot)).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});

	it("a content/header-confirmed generated-name match does not trigger the notice either (evidence: content, not name-only)", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				// WEAK name match ("gen.ts"), but CONFIRMED by a real generated
				// header — the escape hatch checked and found positive evidence,
				// so this is evidence:"content", not evidence:"name-only".
				"src/gen.ts":
					"// This file was automatically generated.\nexport const g = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedFileSkips).toBe(1);
			expect(snapshot.generatedNameOnlySkips).toBeUndefined();
			expect(generatedSkipNotice(snapshot)).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});

	it("generatedDirSkips counts a whole pruned directory, and the notice pluralizes correctly (retained: this case DOES trigger it)", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"generated/one.ts": "export const one = 1;\n",
				"generated/two.ts": "export const two = 2;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedDirSkips).toBe(1);
			const notice = generatedSkipNotice(snapshot);
			expect(notice).toBeDefined();
			expect(notice).toContain("1 directory");
		} finally {
			repo.cleanup();
		}
	});

	// Directly exercises `generatedSkipNotice`'s file-count branch (the
	// `generatedNameOnlySkips` bucket) without needing a real scan to produce
	// one — the default project-walk path always enables the header probe, so
	// a genuine "name-only" skip is rare-to-zero through the scanner itself
	// (by design, per its doc). This proves the notice's own rendering logic
	// still fires correctly for that bucket when it IS populated.
	it("generatedSkipNotice fires and mentions 'no confirming evidence' when generatedNameOnlySkips is set directly", () => {
		const notice = generatedSkipNotice({
			generatedNameOnlySkips: 3,
			generatedDirSkips: undefined,
		});
		expect(notice).toBeDefined();
		expect(notice).toContain("3 file(s)");
		expect(notice).toContain("no confirming evidence");
		expect(notice).toContain("includeGenerated");
	});

	it("an explicit `files` scan never populates the counters (never walked)", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"src/gen.ts":
					"// This file was automatically generated.\nexport const g = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const path = await import("node:path");
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				files: [path.join(repo.root, "packages", "a", "src", "index.ts")],
			});
			expect(snapshot.generatedFileSkips).toBeUndefined();
			expect(snapshot.generatedNameOnlySkips).toBeUndefined();
			expect(snapshot.generatedDirSkips).toBeUndefined();
			expect("generatedFileSkips" in snapshot).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	it("includeGenerated: true bypasses the generated-name filter entirely, so nothing is counted or noticed", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"generated/one.ts": "export const one = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				includeGenerated: true,
			});
			expect(snapshot.generatedDirSkips).toBeUndefined();
			expect(snapshot.generatedFileSkips).toBeUndefined();
			expect(generatedSkipNotice(snapshot)).toBeUndefined();
			// The previously-pruned directory's file is now actually scanned.
			expect(snapshot.filesScanned).toBeGreaterThanOrEqual(2);
		} finally {
			repo.cleanup();
		}
	});
});
