/**
 * turn_end's per-turn dead-code delta (#1477), driven end to end.
 *
 * The helpers in `dead-code-client.test.ts` cover formatting and key identity
 * in isolation. These tests drive the real `handleTurnEnd` path instead, so the
 * gate, the previous-scan diff, the edited-file filter and the advisory push
 * are all exercised as product code — every one of them survived mutation
 * before this file existed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type {
	DeadCodeIssue,
	DeadCodeResult,
} from "../../clients/dead-code-client.js";
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

const CACHE_KEY = "dead-code-python";

function issue(name: string, line: number, file = "mod.py"): DeadCodeIssue {
	return { category: "export", kind: "function", name, file, line };
}

function scan(unusedExports: DeadCodeIssue[]): DeadCodeResult {
	return {
		success: true,
		language: "Python",
		unusedExports,
		unusedFiles: [],
		unusedDeps: [],
		unlistedDeps: [],
		summary: "ok",
	};
}

/** A DeadCodeClient that returns a scripted scan and records every call. */
function stubClient(current: DeadCodeResult) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			id: "python",
			language: "Python",
			detect: () => true,
			owns: (filePath: string) => filePath.toLowerCase().endsWith(".py"),
			ensureAvailable: async () => true,
			analyze: async (cwd: string) => {
				calls.push(cwd);
				return current;
			},
		},
	};
}

/**
 * Seed the previous scan, touch `edited`, run one turn, return the advisory.
 * `edited` paths are project-relative.
 */
async function runTurn(opts: {
	previous: DeadCodeResult | null;
	current: DeadCodeResult;
	edited: string[];
}): Promise<{
	advisory: string;
	analyzeCalls: number;
	cached: DeadCodeResult | null;
	scanDurationMs: number | undefined;
}> {
	const env = setupTestEnvironment("pi-lens-dead-code-turn-");
	try {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		if (opts.previous) {
			cacheManager.writeCache(CACHE_KEY, opts.previous, env.tmpDir);
		}
		const stub = stubClient(opts.current);

		for (const rel of opts.edited) {
			const abs = path.join(env.tmpDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, "x = 1\n");
			cacheManager.addModifiedRange(
				abs,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
		}

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [stub.client],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: { getTestRunTarget: () => null },
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps stub
		} as any);

		const advisory =
			consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
				?.content ?? "";
		const entry = cacheManager.readCache<DeadCodeResult>(CACHE_KEY, env.tmpDir);
		return {
			advisory,
			analyzeCalls: stub.calls.length,
			cached: entry?.data ?? null,
			scanDurationMs: entry?.meta?.scanDurationMs,
		};
	} finally {
		env.cleanup();
	}
}

describe("turn_end dead-code delta", () => {
	it("reports only the symbol the edit orphaned, in the file it edited", async () => {
		const { advisory, analyzeCalls } = await runTurn({
			// `stale` predates the edit; `elsewhere` is new but in an untouched file.
			previous: scan([issue("stale", 3)]),
			current: scan([
				issue("stale", 3),
				issue("fresh", 12),
				issue("elsewhere", 4, "other.py"),
			]),
			edited: ["mod.py"],
		});
		expect(analyzeCalls).toBe(1);
		expect(advisory).toContain(
			"Newly unused Python symbols in files you edited",
		);
		// Pushed the delta at all.
		expect(advisory).toContain("fresh");
		// Diffed against the previous scan.
		expect(advisory).not.toContain("stale");
		// Filtered to the edited files.
		expect(advisory).not.toContain("elsewhere");
	});

	it("skips the re-scan entirely when the turn touched no file it owns", async () => {
		const { advisory, analyzeCalls } = await runTurn({
			previous: scan([]),
			current: scan([issue("fresh", 12)]),
			edited: ["app.ts"],
		});
		expect(analyzeCalls).toBe(0);
		expect(advisory).not.toContain("Newly unused Python symbols");
	});

	it("stays silent when an edit only shifts an existing finding's line", async () => {
		// Inserting lines above a finding moves it. The delta is filtered to the
		// edited file, so a line-sensitive key would report every shifted symbol
		// as newly orphaned by the agent's own edit (#1477 review).
		const { advisory } = await runTurn({
			previous: scan([issue("stale", 3), issue("also_stale", 8)]),
			current: scan([issue("stale", 7), issue("also_stale", 12)]),
			edited: ["mod.py"],
		});
		expect(advisory).not.toContain("Newly unused Python symbols");
		expect(advisory).not.toContain("stale");
	});

	it("keeps the last good cache when this turn's scan fails", async () => {
		// A vulture timeout on one .py turn must not evict the session_start
		// scan — the backoff above would then latch off the poisoned record
		// (#925, #1467).
		const previous = scan([issue("stale", 3)]);
		const { cached } = await runTurn({
			previous,
			current: {
				success: false,
				language: "Python",
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "vulture timed out after 30000ms",
			},
			edited: ["mod.py"],
		});
		expect(cached?.success).toBe(true);
		expect(cached?.unusedExports.map((i) => i.name)).toEqual(["stale"]);
	});

	it("records the scan duration both other cache writers record", async () => {
		const { scanDurationMs } = await runTurn({
			previous: scan([]),
			current: scan([issue("fresh", 12)]),
			edited: ["mod.py"],
		});
		expect(scanDurationMs).toBeTypeOf("number");
	});

	it("survives a malformed deadCodeClients instead of aborting the turn", async () => {
		// Pre-#1477 this block only read a cache and could not throw. It now
		// iterates and awaits, so a bad deps object would take down the whole of
		// handleTurnEnd — every later phase included — without an outer guard.
		const env = setupTestEnvironment("pi-lens-dead-code-malformed-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const abs = path.join(env.tmpDir, "mod.py");
			fs.writeFileSync(abs, "x = 1\n");
			cacheManager.addModifiedRange(
				abs,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await expect(
				handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					// Not iterable — exactly the shape three fixtures were passing.
					deadCodeClients: {},
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
					// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
				} as any),
			).resolves.toBeUndefined();

			// The turn ran to completion: the worklist was consumed, not abandoned.
			expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual(
				[],
			);
		} finally {
			env.cleanup();
		}
	});

	it("reports nothing when there is no previous scan to diff against", async () => {
		const { advisory, analyzeCalls } = await runTurn({
			previous: null,
			current: scan([issue("fresh", 12)]),
			edited: ["mod.py"],
		});
		// The scan still runs — it seeds the baseline for the next turn.
		expect(analyzeCalls).toBe(1);
		expect(advisory).not.toContain("Newly unused Python symbols");
	});
});
