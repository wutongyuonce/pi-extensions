/**
 * turn_end freshness gate over the cached scanner stores — #1622.
 *
 * The live case: gitleaks flagged src:397, the agent edited that file, and the
 * STOP blocker kept citing 397 for the rest of the 30-minute TTL. The #1460
 * existence gate could not see it — the file was still there.
 *
 * The asymmetry under test is the security contract. A DELETED path drops. An
 * EDITED path demotes: it leaves the blocker tier and loses its line number, but
 * it is still surfaced. If an edit could drop it, touching a file would mute a
 * real credential.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: every real export stays, `logLatency` becomes a spy so the
// turn-result telemetry (review round M2) is assertable.
const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

import { CacheManager } from "../../clients/cache-manager.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

const SCANNED_AT_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCANNED_AT = new Date(SCANNED_AT_MS).toISOString();

/**
 * A turn whose edited file still exists, so `validateAdvisoryProvenance` says
 * "current" — exactly the condition under which #1622's replay was invisible.
 */
function setupSecretTurn(prefix: string) {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "freshness-session" });
	const cacheManager = new CacheManager(false);
	const editedFile = path.join(env.tmpDir, "src/edited.ts");
	fs.mkdirSync(path.dirname(editedFile), { recursive: true });
	fs.writeFileSync(editedFile, "export const value = 1;\n");
	cacheManager.addModifiedRange(
		editedFile,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		"freshness-session",
	);
	return { env, runtime, cacheManager };
}

/** Write a secret-bearing file and stamp its mtime relative to the scan. */
function writeSecretFile(
	cwd: string,
	relative: string,
	mtimeMs: number,
): string {
	const file = path.join(cwd, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "const k = 'AKIA...';\n");
	const when = new Date(mtimeMs);
	fs.utimesSync(file, when, when);
	return file;
}

async function turnEndContent(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): Promise<string> {
	await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, { ctxCwd: cwd }));
	return (
		consumeTurnEndFindings(cacheManager, cwd)?.messages?.[0]?.content ?? ""
	);
}

beforeEach(() => logLatency.mockReset());

/** The `turn_end` tool_result telemetry row from the last handled turn. */
function turnEndResult(): {
	result?: string;
	metadata?: Record<string, unknown>;
} {
	const calls = logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((e) => e.type === "tool_result" && e.toolName === "turn_end");
	return (calls[calls.length - 1] ?? {}) as {
		result?: string;
		metadata?: Record<string, unknown>;
	};
}

// ── gitleaks ─────────────────────────────────────────────────────────────────

describe("turn_end gitleaks stale-line freshness gate (#1622)", () => {
	it("DEMOTES a finding whose file was edited after the scan — kept, no line", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-stale-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/config.ts",
				SCANNED_AT_MS + 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 397,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// Still surfaced — an edit must never silence a real secret.
			expect(content).toContain("src/config.ts");
			expect(content).toContain("stale");
			// Demoted out of the blocker tier.
			expect(content).not.toContain("hardcoded secrets detected");
			// And without the coordinate the edit invalidated.
			expect(content).not.toContain("src/config.ts:397");
			expect(content).not.toContain(":397");
		} finally {
			env.cleanup();
		}
	});

	it("keeps an unmodified file's finding as a full-severity blocker", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-fresh-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/config.ts",
				SCANNED_AT_MS - 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 397,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/config.ts:397");
			expect(content).not.toContain("stale");
		} finally {
			env.cleanup();
		}
	});

	it("still drops a finding whose file was deleted after the scan (#1460 holds)", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gl-dead-");
		try {
			const deadFile = writeSecretFile(
				env.tmpDir,
				"scratch/sources.json",
				SCANNED_AT_MS - 5_000,
			);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: deadFile,
							startLine: 1341,
							description: "Detected a Generic API Key",
						},
					],
				},
				env.tmpDir,
			);
			fs.rmSync(path.dirname(deadFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("sources.json");
			expect(content).not.toContain("generic-api-key");
		} finally {
			env.cleanup();
		}
	});
});

// ── trivy secrets (criterion 4) ──────────────────────────────────────────────

describe("turn_end trivy-secrets stale-line freshness gate (#1622 criterion 4)", () => {
	function writeTrivyCache(
		cacheManager: CacheManager,
		cwd: string,
		secrets: Array<{ ruleId: string; file: string; line: number }>,
	) {
		cacheManager.writeCache(
			"trivy",
			{
				success: true,
				scannedAt: SCANNED_AT,
				findings: [],
				secrets,
				licenses: [],
			},
			cwd,
		);
	}

	it("DEMOTES a trivy secret whose file was edited after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-stale-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/creds.ts",
				SCANNED_AT_MS + 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: secretFile, line: 234 },
			]);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("src/creds.ts");
			expect(content).toContain("stale");
			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain(":234");
		} finally {
			env.cleanup();
		}
	});

	it("keeps an unmodified trivy secret as a full-severity blocker", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-fresh-");
		try {
			const secretFile = writeSecretFile(
				env.tmpDir,
				"src/creds.ts",
				SCANNED_AT_MS - 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: secretFile, line: 234 },
			]);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/creds.ts:234");
		} finally {
			env.cleanup();
		}
	});

	it("drops a trivy secret whose file was deleted after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-tv-dead-");
		try {
			const deadFile = writeSecretFile(
				env.tmpDir,
				"scratch/creds.ts",
				SCANNED_AT_MS - 5_000,
			);
			writeTrivyCache(cacheManager, env.tmpDir, [
				{ ruleId: "aws-access-key-id", file: deadFile, line: 234 },
			]);
			fs.rmSync(path.dirname(deadFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("creds.ts");
			expect(content).not.toContain("aws-access-key-id");
		} finally {
			env.cleanup();
		}
	});
});

// ── govulncheck (sibling sweep) ──────────────────────────────────────────────

describe("turn_end govulncheck stale call-site gate (#1622 sibling sweep)", () => {
	function writeGovCache(
		cacheManager: CacheManager,
		cwd: string,
		filename: string,
	) {
		cacheManager.writeCache(
			"govulncheck",
			{
				success: true,
				scannedAt: SCANNED_AT,
				findings: [
					{
						osv: "GO-2024-1234",
						module: "example.com/mod",
						fixedVersion: "v1.2.3",
						trace: [{ filename, line: 88 }],
					},
				],
			},
			cwd,
		);
	}

	it("strips the cached call-site line when the file was edited after the scan", async () => {
		const { env, runtime, cacheManager } =
			setupSecretTurn("pi-lens-gov-stale-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/main.go",
				SCANNED_AT_MS + 5_000,
			);
			writeGovCache(cacheManager, env.tmpDir, goFile);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// The CVE is still real after an edit — it is never dropped.
			expect(content).toContain("GO-2024-1234");
			expect(content).toContain("stale");
			expect(content).not.toContain(":88");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the call-site line for an unmodified file", async () => {
		const { env, runtime, cacheManager } =
			setupSecretTurn("pi-lens-gov-fresh-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/main.go",
				SCANNED_AT_MS - 5_000,
			);
			writeGovCache(cacheManager, env.tmpDir, goFile);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("GO-2024-1234");
			expect(content).toContain("cmd/main.go:88");
			expect(content).not.toContain("stale");
		} finally {
			env.cleanup();
		}
	});
});

// ── Review round H1: a deleted govulncheck call site must not kill the CVE ───

describe("turn_end govulncheck deleted call site (#1622 review H1)", () => {
	function writeGovCacheAt(
		cacheManager: CacheManager,
		cwd: string,
		filename: string,
	) {
		cacheManager.writeCache(
			"govulncheck",
			{
				success: true,
				scannedAt: SCANNED_AT,
				findings: [
					{
						osv: "GO-2024-1234",
						module: "example.com/mod",
						fixedVersion: "v1.2.3",
						trace: [{ filename, line: 88 }],
					},
				],
			},
			cwd,
		);
	}

	// The CVE lives in go.mod, not in the call site. Deleting one traced file
	// does not un-pin the vulnerable dependency, so a delete here must DEMOTE
	// (keep the CVE, strip the coordinate), never drop.
	it("keeps the CVE when its cited call-site file was deleted", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gov-dead-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/gone/main.go",
				SCANNED_AT_MS - 5_000,
			);
			writeGovCacheAt(cacheManager, env.tmpDir, goFile);
			fs.rmSync(path.dirname(goFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("GO-2024-1234");
			expect(content).toContain("upgrade to v1.2.3");
			// The coordinate is gone; the CVE is not.
			expect(content).not.toContain(":88");
		} finally {
			env.cleanup();
		}
	});

	// The header guard must read the POST-gate list. Guarding on the raw cache
	// length can print "Go CVEs reachable from this code" with nothing under it.
	it("never prints the govulncheck header with zero rows beneath it", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-gov-hdr-");
		try {
			const goFile = writeSecretFile(
				env.tmpDir,
				"cmd/gone/main.go",
				SCANNED_AT_MS - 5_000,
			);
			writeGovCacheAt(cacheManager, env.tmpDir, goFile);
			fs.rmSync(path.dirname(goFile), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			const headerIndex = content.indexOf("Go CVEs reachable from this code");
			if (headerIndex !== -1) {
				const after = content.slice(headerIndex);
				const rows = after
					.split("\n")
					.slice(1)
					.filter((line) => line.startsWith("  ") && line.trim().length > 0);
				expect(rows.length).toBeGreaterThan(0);
			}
		} finally {
			env.cleanup();
		}
	});
});

// ── Review round M1 + M2: what a demoted secret says, and how it telemetries ──

describe("turn_end demoted-secret rendering (#1622 review M1/M2)", () => {
	function staleSecretTurn(prefix: string) {
		const ctx = setupSecretTurn(prefix);
		const secretFile = writeSecretFile(
			ctx.env.tmpDir,
			"src/stale.ts",
			SCANNED_AT_MS + 5_000,
		);
		return { ...ctx, secretFile };
	}

	// M1: the line number goes, the rule identity and source must stay. An agent
	// triages an aws-access-token differently from a generic-api-key.
	it("carries the gitleaks rule id and source onto the demoted line", async () => {
		const { env, runtime, cacheManager, secretFile } =
			staleSecretTurn("pi-lens-m1-gl-");
		try {
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: secretFile,
							startLine: 397,
							description: "Generic API key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("src/stale.ts");
			expect(content).toContain("generic-api-key");
			expect(content).toContain("gitleaks");
			expect(content).not.toContain(":397");
		} finally {
			env.cleanup();
		}
	});

	it("carries the trivy rule id and source onto the demoted line", async () => {
		const { env, runtime, cacheManager, secretFile } =
			staleSecretTurn("pi-lens-m1-tv-");
		try {
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [],
					secrets: [
						{ ruleId: "aws-access-key-id", file: secretFile, line: 234 },
					],
					licenses: [],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("src/stale.ts");
			expect(content).toContain("aws-access-key-id");
			expect(content).toContain("trivy");
			expect(content).not.toContain(":234");
		} finally {
			env.cleanup();
		}
	});

	// M2a: "no action required this turn" directly above "re-scan before you
	// trust the all-clear" contradicts itself. The demotion tier needs its own
	// imperative preamble.
	it("does NOT file the demoted secret under the no-action-required label", async () => {
		const { env, runtime, cacheManager, secretFile } =
			staleSecretTurn("pi-lens-m2-label-");
		try {
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: secretFile,
							startLine: 397,
							description: "Generic API key",
						},
					],
				},
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			const secretIndex = content.indexOf("src/stale.ts");
			expect(secretIndex).toBeGreaterThan(-1);
			const label = "ℹ️ Advisory — no action required this turn:";
			const labelBefore = content.lastIndexOf(label, secretIndex);
			// Either the label never appears, or it does not introduce this section.
			if (labelBefore !== -1) {
				const between = content.slice(labelBefore, secretIndex);
				expect(between).toContain("\n\n");
			}
		} finally {
			env.cleanup();
		}
	});

	// M2b: a pending stale secret is not a clean turn.
	it("does not telemetry the turn as clean when a stale secret is the only finding", async () => {
		const { env, runtime, cacheManager, secretFile } =
			staleSecretTurn("pi-lens-m2-telem-");
		try {
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: SCANNED_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: secretFile,
							startLine: 397,
							description: "Generic API key",
						},
					],
				},
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const entry = turnEndResult();
			expect(entry.result).toBeDefined();
			expect(entry.result).not.toBe("clean");
		} finally {
			env.cleanup();
		}
	});

	it("still telemetries a genuinely empty turn as clean", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-m2-clean-");
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);
			expect(turnEndResult().result).toBe("clean");
		} finally {
			env.cleanup();
		}
	});
});
