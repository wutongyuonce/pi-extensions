/**
 * #1562 class-fix coverage: every runner that hands a DIRECTORY to an
 * external binary and lets THAT binary do its own tree walk (as opposed to
 * pi-lens's own `EXCLUDED_DIRS`-aware in-process walker feeding it a
 * pre-filtered file list) must thread the shared scratch-tree exclusion
 * policy (`scratch-tree-policy.ts`) through that tool's native exclude
 * mechanism.
 *
 * Sweep (grepped every `clients/*-client.ts` for a `safeSpawnAsync` call
 * whose args include `cwd`/`targetDir` as a bare positional — i.e. "the
 * binary walks the tree itself", #1562 root-cause shape):
 *   - gitleaks (`clients/gitleaks-client.ts`)  — covered: generated
 *     `--config` scoped allowlist + TS-side backstop
 *     (`gitleaks-scratch-exclusion.test.ts`).
 *   - trivy `fs` (`clients/trivy-client.ts`)    — covered below: `--skip-dirs`.
 *   - opengrep (`clients/opengrep-client.ts`)   — covered below: `--exclude`.
 *   - jscpd (`clients/jscpd-client.ts`)         — ALREADY wired (pre-#1562):
 *     `--ignore` built from `getExcludedDirGlobs()` + `getProjectIgnoreGlobs()`
 *     — not part of this defect.
 *   - vulture (`clients/dead-code-client.ts`)   — different shape (per-edit
 *     `--exclude`, not a session-scan secrets/CVE surface), but its
 *     `VULTURE_EXCLUDES` had independently DRIFTED from `EXCLUDED_DIRS` (a
 *     sibling single-source-of-truth defect found during this sweep) —
 *     covered below.
 *   - knip (`clients/knip-client.ts`)   — config/gitignore-driven, not a raw
 *     directory positional; knip respects `.gitignore` itself, which is
 *     ACCEPTABLE for a dead-code tool (unlike a secrets scanner, missing an
 *     ignored file's dead code is not a security gap) — deliberately left.
 *   - govulncheck (`clients/govulncheck-client.ts`) — Go-package-based
 *     (`-mode=source ./...`, via `go list`), not an arbitrary-byte tree walk;
 *     non-Go scratch content is invisible to it by construction — deliberately
 *     left.
 *   - trivy `config` (IaC misconfig, `clients/dispatch/runners/trivy-config.ts`)
 *     — per-EDIT dispatch runner over a single file already selected by the
 *     dispatch pipeline, not a directory scan — deliberately left.
 *
 * #1562 review-round F1 note: trivy/opengrep still consume the WALKER-PARITY
 * `EXCLUDED_DIRS`-derived list (`getScratchTreeGlobPatterns`/
 * `getScratchTreeDirNames`) tested below — that's correct for trivy's
 * vuln/license scanners and for opengrep's general SAST findings (skipping
 * `dist`/`build`/`vendor` there is the RIGHT call, unlike gitleaks's
 * secrets-only lane). Whether trivy's bundled `secret` scanner needs its own
 * narrower list, the way gitleaks now does (`SECRETS_LANE_SCRATCH_DIR_NAMES`),
 * is deliberately deferred — see the F5 follow-up issue referenced in the
 * PR body; a single `--skip-dirs` invocation can't vary by sub-scanner
 * without a structural change this round didn't attempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getScratchTreeDirNames,
	getScratchTreeFnmatchPatterns,
	getScratchTreeGlobPatterns,
	getSecretsLaneAllowlistPaths,
	isUnderSecretsLaneScratchTree,
	SECRETS_LANE_SCRATCH_DIR_NAMES,
} from "../../clients/scratch-tree-policy.js";
import { EXCLUDED_DIRS } from "../../clients/file-utils.js";

const { safeSpawnAsync, safeSpawn } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	safeSpawn: vi.fn(),
}));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));

describe("scratch-tree-policy — single source of truth (#1562)", () => {
	it("walker-parity tool-format lists are derived from (never a copy that can drift from) EXCLUDED_DIRS", () => {
		const literalNames = EXCLUDED_DIRS.filter(
			(n) => !n.includes("*") && !n.includes("?"),
		);
		expect(getScratchTreeDirNames()).toEqual(literalNames);
		expect(getScratchTreeGlobPatterns().length).toBe(EXCLUDED_DIRS.length);
		expect(getScratchTreeFnmatchPatterns().length).toBe(literalNames.length);
	});
});

// #1562 review-round F1: the first cut of this fix used the FULL
// EXCLUDED_DIRS list as gitleaks's secrets-lane exclusion too. A reviewer
// probe seeded a real-AWS-shaped secret in 9 "walker-only" dirs (build
// OUTPUT / vendored SOURCE / editor config — never pi-ecosystem scratch) and
// found every one of them silently dropped. This pins the fix: those 9 stay
// OUT of the secrets-lane exclusion, while the genuine pi-ecosystem/agent/
// cache dirs stay IN it.
describe("scratch-tree-policy — secrets-lane tier is narrower than walker-parity (#1562 review-round F1)", () => {
	const walkerOnlyProbePaths = [
		"dist/config.js",
		"vendor/lib/keys.go",
		".vscode/launch.json",
		"build/bundle.js",
		"out/main.js",
		"target/release/config.rs",
		"third_party/lib/secrets.py",
		"third-party/lib/secrets.py",
		"coverage/lcov-report/index.html",
	];

	it("the 9-path probe: none of the walker-only dirs are in the secrets-lane dir list", () => {
		const secretsLane = new Set(
			SECRETS_LANE_SCRATCH_DIR_NAMES.map((n) => n.toLowerCase()),
		);
		for (const probePath of walkerOnlyProbePaths) {
			const topDir = probePath.split("/")[0].toLowerCase();
			expect(secretsLane.has(topDir)).toBe(false);
		}
	});

	it("the 9-path probe: isUnderSecretsLaneScratchTree keeps (does not flag) every walker-only path", () => {
		for (const probePath of walkerOnlyProbePaths) {
			expect(isUnderSecretsLaneScratchTree(probePath)).toBe(false);
		}
	});

	it("still excludes genuine pi-ecosystem/agent/cache dirs, including the #1562 fixture", () => {
		expect(
			isUnderSecretsLaneScratchTree(".pi/greedysearch-sources/cline-docs.md"),
		).toBe(true);
		for (const scratchDir of [
			".claude",
			".codex",
			".agents",
			"node_modules",
			".git",
			".next",
			"venv",
		]) {
			expect(isUnderSecretsLaneScratchTree(`${scratchDir}/some/file.txt`)).toBe(
				true,
			);
		}
	});

	it("rejects an ordinary source path and doesn't false-positive on a substring match", () => {
		expect(isUnderSecretsLaneScratchTree("src/config.ts")).toBe(false);
		// Must not false-positive on a filename that merely CONTAINS an
		// excluded name as a substring (e.g. "api.pipeline.ts" vs ".pi").
		expect(isUnderSecretsLaneScratchTree("src/api.pipeline.ts")).toBe(false);
	});

	it("getSecretsLaneAllowlistPaths matches both forward- and back-slash separators (#1562 review-round F4)", () => {
		const patterns = getSecretsLaneAllowlistPaths().map((p) => new RegExp(p));
		const forwardSlash = ".pi/greedysearch-sources/cline-docs.md";
		const backSlash = ".pi\\greedysearch-sources\\cline-docs.md";
		expect(patterns.some((r) => r.test(forwardSlash))).toBe(true);
		expect(patterns.some((r) => r.test(backSlash))).toBe(true);
	});
});

describe("TrivyClient.scan — --skip-dirs threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes a --skip-dirs flag for every scratch-tree glob", async () => {
		const { TrivyClient } = await import("../../clients/trivy-client.js");
		const client = new TrivyClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const glob of getScratchTreeGlobPatterns()) {
			const idx = args.indexOf(glob);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--skip-dirs");
		}
	});
});

describe("OpengrepClient.scan — --exclude threads the shared policy (#1562)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes an --exclude flag for every scratch-tree directory name", async () => {
		const { OpengrepClient } = await import("../../clients/opengrep-client.js");
		const client = new OpengrepClient(false) as unknown as {
			ensureAvailable: () => Promise<boolean>;
			runScan: (cwd: string) => Promise<unknown>;
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});

		await client.runScan("/repo");

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const args = safeSpawnAsync.mock.calls[0][1] as string[];
		for (const name of getScratchTreeDirNames()) {
			const idx = args.indexOf(name);
			expect(idx).toBeGreaterThan(0);
			expect(args[idx - 1]).toBe("--exclude");
		}
	});
});
