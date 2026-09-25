/**
 * #3274: the turn-end scanner-store reads are asynchronous and BOUNDED, and
 * the composer's memo still hands every lane one envelope per store.
 *
 * Recurrence prevented: `turn_end` read gitleaks, trivy and govulncheck
 * through the SYNCHRONOUS `CacheManager.readCache` — six `existsSync` and six
 * `readFileSync`+`JSON.parse` on a hook path that nothing could bound, because
 * `bounded()` takes a promise and the read completed during argument
 * evaluation (#3274's probe: an already-aborted signal with `ms: 0` returned
 * `undefined` while the read had already parsed). The memo now holds the
 * PROMISE of each store, under `bounded()` with the turn_end budget and the
 * hook's signal.
 *
 * Every case drives the real `handleTurnEnd`, the real lanes, the real
 * freshness gate and the real `CacheManager`. The only thing scripted is the
 * store read's TIMING — a subclass of the production cache manager, which is
 * the seam a wedged filesystem would move.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Partial mock: every real export stays, `logLatency` becomes a spy so the
// per-delivery unread-store row is assertable.
const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

import { CacheManager, type CacheEntry } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { GitleaksResult } from "../../clients/gitleaks-client.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { _resetInstanceRegistryEnabledForTests } from "../../clients/instance-registry.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import type { TrivyResult } from "../../clients/trivy-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const SCAN_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCAN_AT = new Date(SCAN_MS).toISOString();

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

/**
 * The production cache manager with the scanner reads' TIMING under test
 * control. No module mock and no stubbed parse: `hang` makes one store's read
 * never settle (the wedged filesystem #2523 measured), `onlyFirstRead` makes a
 * store answer once and then behave as a cold cache — which is what a TTL
 * boundary falling between two reads looks like to the second reader.
 */
class ScriptedCacheManager extends CacheManager {
	readonly reads: string[] = [];
	readonly hang = new Set<string>();
	readonly onlyFirstRead = new Set<string>();
	private readonly hung: Array<(entry: CacheEntry<unknown> | null) => void> =
		[];
	/**
	 * Settles the instant a wedged read is DISPATCHED (#3326). The timer case
	 * has to know when the composer is blocked on that read, and the event is
	 * exposed rather than polled: polling made the length of the wait a function
	 * of machine load — see {@link turnEndBlockedOn}.
	 */
	private readonly wedged = ((): {
		arrived: Promise<void>;
		dispatch: () => void;
	} => {
		let dispatch!: () => void;
		const arrived = new Promise<void>((resolve) => {
			dispatch = resolve;
		});
		return { arrived, dispatch };
	})();

	override readCacheAsync<T>(
		scanner: string,
		cwd: string,
		maxAgeMs?: number,
	): Promise<CacheEntry<T> | null> {
		const seenBefore = this.reads.includes(scanner);
		this.reads.push(scanner);
		if (this.hang.has(scanner)) {
			return new Promise<CacheEntry<T> | null>((resolve) => {
				this.hung.push(resolve as (e: CacheEntry<unknown> | null) => void);
				this.wedged.dispatch();
			});
		}
		if (seenBefore && this.onlyFirstRead.has(scanner)) {
			return Promise.resolve(null);
		}
		return maxAgeMs === undefined
			? super.readCacheAsync<T>(scanner, cwd)
			: super.readCacheAsync<T>(scanner, cwd, maxAgeMs);
	}

	/** Settle every wedged read — the late answer the bound already gave up on. */
	releaseHung(entry: CacheEntry<unknown> | null): void {
		for (const resolve of this.hung.splice(0)) resolve(entry);
	}

	/**
	 * Resolves once a wedged read is in flight — and, because the resolution
	 * happens inside `readCacheAsync`'s own synchronous return, once the
	 * `bounded()` deadline the memo arms around it is armed too.
	 */
	whenWedged(): Promise<void> {
		return this.wedged.arrived;
	}

	countOf(scanner: string): number {
		return this.reads.filter((name) => name === scanner).length;
	}
}

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	signal?: AbortSignal,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		...(signal === undefined ? {} : { signal }),
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

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: ScriptedCacheManager;

/**
 * One secret per store, in DIFFERENT files, each older than the scan so
 * nothing is demoted by the freshness gate. Different files on purpose: two
 * secrets at one location fold into a single row with combined provenance
 * (#131 Mode 3), which would leave "did the trivy store reach the agent?"
 * readable only from a provenance tag.
 */
function warmStores(): void {
	const when = new Date(SCAN_MS - 5_000);
	const write = (relative: string, content: string): string => {
		const file = path.join(env.tmpDir, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		fs.utimesSync(file, when, when);
		return file;
	};
	const file = write("src/live.ts", "const k = 'AKIAIOSFODNN7EXAMPLE';\n");
	const dep = write("src/dep.ts", "aws_secret = 'z'\n");
	// turn_end only composes for a turn that touched something.
	cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		"bound-session",
	);
	cacheManager.writeCache(
		"gitleaks",
		{
			success: true,
			scannedAt: SCAN_AT,
			findings: [
				{
					ruleId: "aws-access-token",
					file,
					startLine: 1,
					description: "AWS key",
				},
			],
		} satisfies GitleaksResult,
		env.tmpDir,
	);
	cacheManager.writeCache(
		"trivy",
		{
			success: true,
			scannedAt: SCAN_AT,
			findings: [],
			secrets: [{ ruleId: "aws-secret-access-key", file: dep, line: 1 }],
			licenses: [],
		} satisfies TrivyResult,
		env.tmpDir,
	);
	cacheManager.reads.length = 0;
}

async function turnEndContent(signal?: AbortSignal): Promise<string> {
	await handleTurnEnd(
		makeTurnEndDeps(runtime, cacheManager, env.tmpDir, signal),
	);
	return (
		consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]?.content ??
		""
	);
}

/** Every `logLatency` phase row of one phase name from the turn just handled. */
function phaseRecords(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((entry) => entry.type === "phase" && entry.phase === phase);
}

// turn_end fires `void updateHeartbeat()` and never waits for it; a contended
// registry lock arms a ~20 ms backoff timer that belongs to that fire-and-forget
// chain, not to the hook. The timer case below counts timers, so the registry is
// off through its own shipped kill switch — see the same block in
// `tests/clients/blocker-freshness-turn-end.test.ts` for the measurement.
beforeAll(() => {
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	_resetInstanceRegistryEnabledForTests();
});

afterAll(() => {
	vi.unstubAllEnvs();
	_resetInstanceRegistryEnabledForTests();
});

beforeEach(() => {
	logLatency.mockReset();
	resetDegradationLedger();
	env = setupTestEnvironment("pi-lens-3274-bound-");
	runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "bound-session" });
	cacheManager = new ScriptedCacheManager(false);
});

afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

/**
 * Run one delivery whose `hangingStore` read never settles, with the clock
 * under test control for the whole turn and spent ONLY on the bound under
 * test.
 *
 * Recurrence prevented (#3326): this helper used to reach the wedged read by
 * pumping `advanceTimersByTimeAsync(1)` up to 200 times, which made both the
 * readiness gate and the fake clock's position depend on MACHINE LOAD — the
 * case failed three of six master CI runs (35850547437, 35852405937,
 * 35855588796) and reproduced here at 6/10 parallel runs under 24 CPU hogs
 * with `expected 0 to be greater than 0` from that gate. Two measured reasons,
 * both fixed by waiting on the event instead of on a tick count:
 *
 * - Everything the composer does before the wedged read — the govulncheck and
 *   trivy store reads — is a REAL `fs.promises` read on the libuv threadpool,
 *   so the number of event-loop turns before the wedged read is dispatched
 *   grows with contention while the turns themselves stay cheap: measured 151
 *   turns on an idle box against 1_200+ under load, versus a cap of 200.
 * - Each pumped tick also SPENT fake time. Under load the pump could reach
 *   3000 ms of it while the trivy read was still in flight, firing that read's
 *   own `bounded()` deadline too — measured on a loaded run as a
 *   `stores: "trivy+gitleaks"` row where the case asserts `"gitleaks"`.
 *
 * So the clock is installed before the turn starts (the deadline `bounded()`
 * arms per read must be a FAKE timer) and then frozen: the composer reaches
 * the wedged read with no clock movement at all — measured at 3-16 real
 * event-loop turns, idle and loaded, with the three 3000 ms read deadlines the
 * only timers armed — and the single advance below is the budget under test.
 * A turn that never reaches the read fails on vitest's own test timeout
 * (measured with fake timers installed: `Test timed out in 1500ms`), which is
 * the loud failure the trip count was hand-rolling.
 */
async function turnEndBlockedOn(hangingStore: string): Promise<string> {
	cacheManager.hang.add(hangingStore);
	vi.useFakeTimers();
	let settled = false;
	const turn = handleTurnEnd(
		makeTurnEndDeps(runtime, cacheManager, env.tmpDir),
	).then(() => {
		settled = true;
	});
	await cacheManager.whenWedged();
	await vi.advanceTimersByTimeAsync(3_100);
	await turn;
	vi.useRealTimers();
	expect(settled).toBe(true);
	return (
		consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]?.content ??
		""
	);
}

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

describe("#3274: the turn-end scanner reads are bounded and shared", () => {
	it("hands both trivy consumers the SAME envelope, not a second read (F1)", async () => {
		warmStores();
		// A store that answers only its FIRST reader is what a TTL boundary
		// between two reads looks like: the composer reads trivy for the
		// CVE/license tiers, the secrets lane reads it for its rows. A memo that
		// holds a promise per store gives both the same envelope; a memo that
		// re-read — or no memo at all — would leave the second one with a cold
		// cache and silently drop a secret that is really in the store.
		cacheManager.onlyFirstRead.add("trivy");

		const content = await turnEndContent();

		expect(content).toContain("aws-secret-access-key");
		expect(cacheManager.countOf("trivy")).toBe(1);
		// A healthy delivery writes no unread-store row: the record has to be a
		// discriminator, not a line every turn emits (#2654's shape).
		expect(phaseRecords("scanner_cache_read_abandoned")).toEqual([]);
	});

	it("starts only reads it awaits, so no deadline outlives the turn (F9)", async () => {
		// #3305 review H3305-1. Each read arms a 3000 ms `bounded()` deadline;
		// `bounded()` clears it in its own try/finally BEFORE the promise the
		// composer awaits settles, so a read the composer started and awaited is
		// a timer the composer has already released when it returns. A read
		// started and NOT awaited breaks that, and the break is observable
		// rather than counted: the orphan deadline fires after the turn and
		// abandons a read the turn already delivered on, writing the ledger row
		// and the unread-store row for a delivery that had neither.
		//
		// Asserted this way rather than with `vi.getTimerCount()`, because that
		// count also sees timers this hook neither owns nor awaits — measured on
		// this very turn: 12 timers armed, all 12 cleared, and the count still
		// reads 1 (a timer armed through a channel a `globalThis.setTimeout`
		// probe does not intercept).
		//
		// The LIVE half is the read count: a `void readScannerCache(...)` planted
		// in the composer reds it (`expected [ 'govulncheck', 'trivy', …(2) ] to
		// have a length of 3 but got 4`). The ledger half is a belt whose red
		// needs an orphan read that also never settles — stated rather than
		// claimed, because an orphan read of a MISSING store settles on its own
		// and its deadline is cleared with it (measured: the same planted call
		// with this floor lifted leaves the ledger empty).
		warmStores();
		vi.useFakeTimers();
		try {
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			// Three stores were really read, so three deadlines were really armed
			// — the assertions below are not vacuous.
			expect(cacheManager.reads).toHaveLength(3);

			await vi.advanceTimersByTimeAsync(2 * 3_000);

			expect(summaryFor("hook-await-exceeded")).toBeUndefined();
			expect(phaseRecords("scanner_cache_read_abandoned")).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads each store once per DELIVERY, never once per session (F5)", async () => {
		warmStores();
		await turnEndContent();
		const afterFirst = cacheManager.countOf("gitleaks");
		await turnEndContent();

		// The memo is built inside `handleTurnEnd`, so the second delivery reads
		// the store again — a memo that outlived the turn would serve a stale
		// envelope for the rest of the session.
		expect(afterFirst).toBe(1);
		expect(cacheManager.countOf("gitleaks")).toBe(2);
	});

	it("does not read a store at all when the turn is already aborted (F6)", async () => {
		warmStores();

		const content = await turnEndContent(AbortSignal.abort());

		// `bounded()` abandons the await but cannot cancel a read already
		// dispatched, so the guard is in the memo: an aborted turn pays no file
		// reads, and every lane sees the cold-cache answer.
		expect(cacheManager.countOf("gitleaks")).toBe(0);
		expect(cacheManager.countOf("trivy")).toBe(0);
		expect(cacheManager.countOf("govulncheck")).toBe(0);
		expect(content).not.toContain("aws-access-token");
	});

	it("abandons a wedged store read at the turn_end budget, delivers the rest, and records one row (F2)", async () => {
		warmStores();

		const content = await turnEndBlockedOn("gitleaks");

		// Null is the cold-cache answer, not an empty store: the gitleaks tier is
		// absent, the trivy secret from the store that DID answer is delivered,
		// and the abandonment is on the ledger rather than silent. Before #3274
		// this read could not be abandoned at all — it ran to completion during
		// argument evaluation, so a wedged filesystem held the whole hook.
		expect(content).not.toContain("aws-access-token");
		expect(content).toContain("aws-secret-access-key");
		const group = summaryFor("hook-await-exceeded");
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"turn_end:readScannerCache:gitleaks",
		);
		expect(group?.count).toBe(1);
		// ONE row per delivery naming the store the tiers were composed without —
		// the consequence `hook-await-exceeded` does not state, and the only
		// record at all when the bound's caller-abort arm fires.
		const unread = phaseRecords("scanner_cache_read_abandoned");
		expect(unread).toHaveLength(1);
		expect(unread[0]!.metadata).toMatchObject({
			stores: "gitleaks",
			aborted: false,
		});
	});

	it("is inert when the abandoned read resolves after the delivery composed (F3)", async () => {
		warmStores();

		const content = await turnEndBlockedOn("gitleaks");

		// The read the bound gave up on now answers, with a store full of
		// findings. The memo holds a SETTLED promise, so there is nothing for the
		// late envelope to overwrite, nothing re-enters the delivery that already
		// shipped, and no unhandled rejection can surface from it.
		cacheManager.releaseHung({
			data: {
				success: true,
				scannedAt: SCAN_AT,
				findings: [
					{
						ruleId: "aws-access-token",
						file: path.join(env.tmpDir, "src/live.ts"),
						startLine: 1,
					},
				],
			},
			meta: { timestamp: SCAN_AT },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(content).not.toContain("aws-access-token");
		// Nothing was written for the agent after the fact either: the turn's one
		// delivery was consumed above, and the late answer produces no second one.
		expect(
			consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]?.content,
		).toBeUndefined();
	});
});
