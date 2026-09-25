/**
 * #1892 slice 1 — the three cached scanner lanes share ONE path-freshness pass.
 *
 * Before this, `handleTurnEnd` called `gateFindingsByPathFreshness` once per
 * store. One file cited by gitleaks AND trivy-secrets — the common case, since
 * both scan the same tree for the same secret — was stat'd twice, spent two
 * separate stat budgets, and wrote TWO `finding_stale_line_demote` rows for one
 * decision about one file.
 *
 * The fold is only safe if source identity survives it, so the two directions
 * that must NOT collapse are pinned here as well: a store's `scannedAt` decides
 * its own findings' staleness and nobody else's, and a store's `onMissing`
 * policy decides its own findings' deletion and nobody else's.
 *
 * Everything below drives the real `CacheManager`, the real gate and the real
 * `handleTurnEnd`. The scanner processes are the only boundary, and they are
 * stubbed where they belong — at their RESULT cache, which is what turn_end
 * reads in production anyway.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: every real export stays, `logLatency` becomes a spy so the
// bounded decision records are assertable.
const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

import { CacheManager } from "../../clients/cache-manager.js";
import type { GitleaksResult } from "../../clients/gitleaks-client.js";
import type { GovulncheckResult } from "../../clients/govulncheck-client.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import type { TrivyResult } from "../../clients/trivy-client.js";
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
	cwd: string,
) {
	return {
		ctxCwd: cwd,
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
	} as unknown as Parameters<typeof handleTurnEnd>[0];
}

const SCAN_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCAN_AT = new Date(SCAN_MS).toISOString();

function setupTurn(prefix: string) {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "fold-session" });
	const cacheManager = new CacheManager(false);
	const edited = path.join(env.tmpDir, "src/edited.ts");
	fs.mkdirSync(path.dirname(edited), { recursive: true });
	fs.writeFileSync(edited, "export const value = 1;\n");
	cacheManager.addModifiedRange(
		edited,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		"fold-session",
	);
	return { env, runtime, cacheManager };
}

function writeFileAt(cwd: string, relative: string, mtimeMs: number): string {
	const file = path.join(cwd, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "const k = 'AKIA...';\n");
	const when = new Date(mtimeMs);
	fs.utimesSync(file, when, when);
	return file;
}

/** Keep the durable fixture envelope on the same epoch as its scannedAt data. */
function writeFixtureCache<T>(
	cacheManager: CacheManager,
	scanner: string,
	data: T,
	cwd: string,
): void {
	cacheManager.writeCache(scanner, data, cwd, { timestamp: SCAN_AT });
}

async function turnEndContent(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): Promise<string> {
	await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
	return (
		consumeTurnEndFindings(cacheManager, cwd)?.messages?.[0]?.content ?? ""
	);
}

/** Every `logLatency` phase row of one phase name from the turn just handled. */
function phaseRecords(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((entry) => entry.type === "phase" && entry.phase === phase);
}

// #3315: the cache TTL is measured from writeCache's envelope timestamp, while
// the scanner fixtures intentionally remain at SCAN_MS. Pin both clocks to the
// fixture epoch so this witness cannot age into stale-cache output as the
// calendar advances; the real-time clock is restored after every case.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(SCAN_MS));
	logLatency.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("#1892: one shared freshness pass for the turn-end scanner lanes", () => {
	// The measured pre-fix shape: two stores, one file, TWO demote records and
	// two stats. The decision is about ONE file — the agent-facing consequence
	// is identical — so the record is one, with the per-store breakdown that
	// keeps it discriminating.
	it("writes ONE demote record and pays ONE stat when two stores cite the same edited file", async () => {
		const { env, runtime, cacheManager } = setupTurn("pi-lens-1892-shared-");
		try {
			const shared = writeFileAt(env.tmpDir, "src/shared.ts", SCAN_MS + 5_000);
			writeFixtureCache(
				cacheManager,
				"gitleaks",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: shared,
							startLine: 397,
							description: "AWS key",
						},
					],
				} satisfies GitleaksResult,
				env.tmpDir,
			);
			writeFixtureCache(
				cacheManager,
				"trivy",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [],
					secrets: [{ ruleId: "aws-access-key-id", file: shared, line: 234 }],
					licenses: [],
				} satisfies TrivyResult,
				env.tmpDir,
			);

			await turnEndContent(runtime, cacheManager, env.tmpDir);

			const demotes = phaseRecords("finding_stale_line_demote");
			expect(demotes).toHaveLength(1);
			expect(demotes[0]!.metadata).toMatchObject({
				store: "gitleaks+trivy-secrets",
				byStore: { gitleaks: 1, "trivy-secrets": 1 },
				demotedStalePaths: 2,
				// The whole point: ONE file, ONE stat, however many stores ask.
				statCount: 1,
				stalePathCount: 1,
			});
			// Each store's own scan timestamp survives into the record; a single
			// flattened `scannedAt` here would be the authority collapse the gate
			// refuses to make on the findings.
			expect(demotes[0]!.metadata).toHaveProperty("scannedAtByStore");
		} finally {
			env.cleanup();
		}
	});

	// Direction 1 of the fold's hazard. gitleaks scanned BEFORE the edit, trivy
	// AFTER it. Sharing the pass must not share the reference timestamp: a
	// store whose own scan already covers the current bytes keeps its blocker.
	it("judges each store against ITS OWN scannedAt — a newer scan is not demoted by an older one", async () => {
		const { env, runtime, cacheManager } = setupTurn("pi-lens-1892-scanat-");
		try {
			const shared = writeFileAt(env.tmpDir, "src/shared.ts", SCAN_MS + 30_000);
			writeFixtureCache(
				cacheManager,
				"gitleaks",
				{
					success: true,
					// Older than the file's mtime → this store's line is untrustworthy.
					scannedAt: SCAN_AT,
					findings: [
						{
							ruleId: "aws-access-token",
							file: shared,
							startLine: 397,
							description: "AWS key",
						},
					],
				} satisfies GitleaksResult,
				env.tmpDir,
			);
			writeFixtureCache(
				cacheManager,
				"trivy",
				{
					success: true,
					// Newer than the file's mtime → this store saw the current bytes.
					scannedAt: new Date(SCAN_MS + 60_000).toISOString(),
					findings: [],
					secrets: [{ ruleId: "aws-access-key-id", file: shared, line: 234 }],
					licenses: [],
				} satisfies TrivyResult,
				env.tmpDir,
			);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// trivy's finding is live: full blocker tier, line intact.
			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/shared.ts:234");
			// gitleaks' finding is demoted: named in the stale tier, no line.
			expect(content).toContain("aws-access-token [gitleaks]");
			expect(content).not.toContain(":397");
			const demotes = phaseRecords("finding_stale_line_demote");
			expect(demotes).toHaveLength(1);
			expect(demotes[0]!.metadata).toMatchObject({
				store: "gitleaks",
				byStore: { gitleaks: 1 },
			});
		} finally {
			env.cleanup();
		}
	});

	// Direction 2 of the fold's hazard, and the sharpest one: the SAME deleted
	// path means different things to different stores. govulncheck demotes (the
	// CVE is pinned by go.mod, a deleted call site does not un-pin it); gitleaks
	// drops (a credential in a deleted file cannot be rotated). A shared memo
	// that cached the post-policy verdict would serve one store's answer to the
	// other — the #1892 cross-source retirement this gate has to refuse.
	it("applies each store's OWN onMissing policy to one shared deleted path", async () => {
		const { env, runtime, cacheManager } = setupTurn("pi-lens-1892-missing-");
		try {
			const gone = writeFileAt(env.tmpDir, "gone/main.go", SCAN_MS - 5_000);
			writeFixtureCache(
				cacheManager,
				"govulncheck",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [
						{
							osv: "GO-2026-1234",
							module: "example.com/mod",
							fixedVersion: "v1.2.3",
							trace: [{ filename: gone, line: 88 }],
						},
					],
				} satisfies GovulncheckResult,
				env.tmpDir,
			);
			writeFixtureCache(
				cacheManager,
				"gitleaks",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [
						{
							ruleId: "generic-api-key",
							file: gone,
							startLine: 1341,
							description: "Detected a Generic API Key",
						},
					],
				} satisfies GitleaksResult,
				env.tmpDir,
			);
			fs.rmSync(path.dirname(gone), { recursive: true, force: true });

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// govulncheck: kept, coordinate stripped.
			expect(content).toContain("GO-2026-1234");
			expect(content).toContain("upgrade to v1.2.3");
			expect(content).not.toContain(":88");
			// gitleaks: dropped outright, from both the blocker and stale tiers.
			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("generic-api-key");
			// Both decisions, one delivery, one record each — and each names only
			// the store it actually retired or demoted.
			const drops = phaseRecords("finding_dead_path_drop");
			expect(drops).toHaveLength(1);
			expect(drops[0]!.metadata).toMatchObject({
				store: "gitleaks",
				byStore: { gitleaks: 1 },
			});
			const demotes = phaseRecords("finding_stale_line_demote");
			expect(demotes).toHaveLength(1);
			expect(demotes[0]!.metadata).toMatchObject({
				store: "govulncheck",
				byStore: { govulncheck: 1 },
			});
			// One deleted path, stat'd once for both stores.
			expect(drops[0]!.metadata).toMatchObject({ statCount: 1 });
		} finally {
			env.cleanup();
		}
	});
});

// ── Old durable records (the fixture-corpus rule) ────────────────────────────

const FIXTURE_DIR = path.join(
	import.meta.dirname,
	"../fixtures/scanner-cache-4.2.1",
);
const FIXTURE_ROOT = path.join(import.meta.dirname, "../fixtures");

interface ScannerCacheFieldManifest {
	version: string;
	records: Record<string, string[]>;
}

function loadScannerCacheFieldManifest(
	directory: string,
): ScannerCacheFieldManifest {
	return JSON.parse(
		fs.readFileSync(path.join(directory, "manifest.json"), "utf-8"),
	) as ScannerCacheFieldManifest;
}

function loadFixture<T>(name: string, cwd: string): T {
	const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf-8");
	return JSON.parse(raw.replaceAll("__PROJECT_ROOT__", cwd)) as T;
}

describe("#1892: scanner cache records written by 4.2.1 still parse and render", () => {
	it("keeps every versioned scanner-cache fixture within its producer field manifest", () => {
		// Prevents #3429: a fixture must not claim fields its named version's
		// client never persisted. The manifest is checked in beside the corpus so
		// this test remains independent of Git history and the current clients.
		const directories = fs
			.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith("scanner-cache-"),
			);

		for (const directory of directories) {
			const fixtureDirectory = path.join(FIXTURE_ROOT, directory.name);
			const version = directory.name.slice("scanner-cache-".length);
			const manifest = loadScannerCacheFieldManifest(fixtureDirectory);
			expect(manifest.version).toBe(version);

			const fixtureNames = fs
				.readdirSync(fixtureDirectory)
				.filter((name) => name.endsWith(".json") && name !== "manifest.json")
				.sort();
			expect(Object.keys(manifest.records).sort()).toEqual(fixtureNames);

			for (const fixtureName of fixtureNames) {
				const record = JSON.parse(
					fs.readFileSync(path.join(fixtureDirectory, fixtureName), "utf-8"),
				) as Record<string, unknown>;
				const allowedFields = manifest.records[fixtureName];
				expect(
					Object.keys(record).every((field) => allowedFields.includes(field)),
				).toBe(true);
			}
		}
	});

	// The reader changed, the record did not. A 4.2.1 cache left on disk across
	// an upgrade must come back field-for-field and still reach the agent — the
	// failure mode a refactor of the READ path can introduce silently, because
	// every hand-written test object is authored against the NEW code.
	it("round-trips all three 4.2.1 records and renders each lane", async () => {
		const { env, runtime, cacheManager } = setupTurn("pi-lens-1892-legacy-");
		try {
			// The cited paths must exist and predate the scan, or the freshness
			// gate would (correctly) drop/demote them and hide a parse failure.
			writeFileAt(env.tmpDir, "src/config.ts", SCAN_MS - 5_000);
			writeFileAt(env.tmpDir, "cmd/main.go", SCAN_MS - 5_000);

			const gitleaks = loadFixture<GitleaksResult>("gitleaks", env.tmpDir);
			const trivy = loadFixture<TrivyResult>("trivy", env.tmpDir);
			const gov = loadFixture<GovulncheckResult>("govulncheck", env.tmpDir);
			writeFixtureCache(cacheManager, "gitleaks", gitleaks, env.tmpDir);
			writeFixtureCache(cacheManager, "trivy", trivy, env.tmpDir);
			writeFixtureCache(cacheManager, "govulncheck", gov, env.tmpDir);

			// The real reader gives back every field the 4.2.1 record carried.
			expect(
				cacheManager.readCache<GitleaksResult>("gitleaks", env.tmpDir)?.data,
			).toEqual(gitleaks);
			expect(
				cacheManager.readCache<TrivyResult>("trivy", env.tmpDir)?.data,
			).toEqual(trivy);
			expect(
				cacheManager.readCache<GovulncheckResult>("govulncheck", env.tmpDir)
					?.data,
			).toEqual(gov);

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// gitleaks + trivy secret collapse to one blocker at the same file.
			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/config.ts:397");
			// trivy CVE (package-pinned: age label, no path to stat) and license.
			expect(content).toContain("CVE-2026-0001");
			expect(content).toContain("AGPL-3.0");
			// govulncheck keeps its call-site coordinate on an unmodified file.
			expect(content).toContain("GO-2026-1234");
			expect(content).toContain("cmd/main.go:88");
		} finally {
			env.cleanup();
		}
	});
});

/**
 * A subclass of the REAL cache manager that counts reads — no module mock, no
 * stubbed read. Everything below it is the production path.
 *
 * #3274: BOTH read seams are counted, into one list keyed by store. The
 * scanner stores moved to `readCacheAsync`, so a double that watched only the
 * synchronous method would have reported `perStore("trivy") === 0` and passed
 * the one-read rule by seeing nothing at all — measured on this very test when
 * the migration landed:
 * `expected +0 to be 1` at `expect(perStore("trivy")).toBe(1)`. Counting both
 * also keeps the rule honest ACROSS the seams while #3300 migrates the rest: a
 * store read once through each method is two reads of one store, which is the
 * TTL-boundary split #1892 exists to prevent, and it reds here.
 */
class CountingCacheManager extends CacheManager {
	readonly reads: string[] = [];
	override readCache<T>(
		scanner: string,
		cwd: string,
		maxAgeMs?: number,
	): ReturnType<typeof CacheManager.prototype.readCache<T>> {
		this.reads.push(scanner);
		return maxAgeMs === undefined
			? super.readCache<T>(scanner, cwd)
			: super.readCache<T>(scanner, cwd, maxAgeMs);
	}
	override readCacheAsync<T>(
		scanner: string,
		cwd: string,
		maxAgeMs?: number,
	): ReturnType<typeof CacheManager.prototype.readCacheAsync<T>> {
		this.reads.push(scanner);
		return maxAgeMs === undefined
			? super.readCacheAsync<T>(scanner, cwd)
			: super.readCacheAsync<T>(scanner, cwd, maxAgeMs);
	}
}

describe("#1892: one read per scanner store per delivery", () => {
	// Recurrence prevented: the inline turn-end lanes each read their store into
	// a local, so one delivery saw one envelope per store for free. Extracting a
	// lane (#1892) gives it its own `readScannerCache`, and the trivy store is
	// read by BOTH the secrets lane (its `secrets` rows) and the composer (the
	// CVE/license tiers and the age label). Two reads of one store inside one
	// delivery is the parallel-store shape this umbrella exists to kill — and the
	// cache's TTL boundary can fall between them, so the secrets tier and the CVE
	// tier would then disagree about the same store.
	it("reads trivy ONCE although the lane and the composer both need it", async () => {
		const env = setupTestEnvironment("pi-lens-1892-onereads-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "onereads-session" });
			const cacheManager = new CountingCacheManager(false);
			const edited = writeFileAt(env.tmpDir, "src/edited.ts", SCAN_MS - 5_000);
			cacheManager.addModifiedRange(
				edited,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"onereads-session",
			);
			writeFixtureCache(
				cacheManager,
				"gitleaks",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [
						{ ruleId: "aws-access-token", file: edited, startLine: 1 },
					],
				} satisfies GitleaksResult,
				env.tmpDir,
			);
			writeFixtureCache(
				cacheManager,
				"trivy",
				{
					success: true,
					scannedAt: SCAN_AT,
					findings: [],
					secrets: [{ ruleId: "aws-access-key-id", file: edited, line: 1 }],
					licenses: [],
				} satisfies TrivyResult,
				env.tmpDir,
			);
			cacheManager.reads.length = 0;

			const content = await turnEndContent(runtime, cacheManager, env.tmpDir);

			// Both stores actually reached the agent through this one read each.
			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("aws-access-token");
			const perStore = (scanner: string) =>
				cacheManager.reads.filter((name) => name === scanner).length;
			expect(perStore("trivy")).toBe(1);
			expect(perStore("gitleaks")).toBe(1);
			expect(perStore("govulncheck")).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});
