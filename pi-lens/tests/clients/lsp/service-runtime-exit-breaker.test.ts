/**
 * Regression coverage for #1127 (opengrep respawn churn, #1122 Phase C).
 *
 * `LSPService`'s circuit breaker (`clients/lsp/index.ts`) only counted
 * spawn/initialize FAILURES toward `failureCounts` → exponential cooldown →
 * permanent disable after BROKEN_PERMANENT_AFTER. A server whose spawn
 * SUCCEEDS but then exits shortly after (opengrep's post-init "Unhandled
 * message" crash) hit the "dead client — needs respawn" path instead, which
 * never touched the breaker: 37 respawns in one real session, never
 * converging.
 *
 * The fix adds a parallel `runtimeExitCounts` counter, fed only by EARLY
 * (lifetime < RUNTIME_EXIT_UPTIME_THRESHOLD_MS) non-intentional exits, sharing
 * the same cooldown formula and the same `state.broken`/`permanentlyBroken`
 * maps as the existing breaker. Deliberate teardowns (`shutdown()` called by
 * pi-lens itself — session reset, #743 notify-backpressure eviction) set
 * `shutdownRequested` and must never count.
 *
 * Crucially, "lifetime" is measured from the client's own recorded death
 * (`getExitedAt()`, stamped by `client.ts`'s exit handlers the moment the
 * process/connection actually dies) — NOT from when a later `getClientForFile`
 * call happens to detect the client is dead. #1127's real-world pattern is
 * attach-triggered respawns "minutes to hours apart": a server that died 5s
 * after spawning but wasn't attached-to again for an hour must still read as
 * an early, breaker-worthy exit.
 *
 * The fixture root is deliberately a legitimate child of the session cwd.
 * Root-policy tests cover ceiling/clamping separately; these tests isolate
 * breaker behavior and assert the same canonical root used by the client map
 * on every host OS.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise, starveBudget } from "../../support/fault-injection.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const FIXTURE_ROOT = path.join(process.cwd(), "runtime-exit-breaker-fixture");
const FIXTURE_FILE = path.join(FIXTURE_ROOT, "main.fake");

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

/**
 * A fake client whose `isAlive()`/`wasShutdownIntentional()`/`getExitedAt()`
 * the test drives directly. `exitedAt` defaults to `undefined` (not yet died)
 * and is only set via `die()`, mirroring the real client.ts contract: it's
 * stamped once, at the moment of death, independent of when anything later
 * notices via `isAlive()`.
 */
function makeFakeClient(serverId: string) {
	const fake = {
		alive: true,
		intentional: false,
		exitedAt: undefined as number | undefined,
		diagnosticsVersion: 0,
		serverId,
		isAlive: () => fake.alive,
		wasShutdownIntentional: () => fake.intentional,
		getExitedAt: () => fake.exitedAt,
		shutdown: vi.fn().mockImplementation(async () => {
			fake.intentional = true; // mirrors clientShutdown() setting shutdownRequested
		}),
		notify: {
			open: vi.fn().mockResolvedValue(undefined),
			change: vi.fn().mockResolvedValue(undefined),
		},
		/** Unexpected crash: dies at `at` (defaults to now), never called shutdown(). */
		die(at: number = Date.now()) {
			fake.exitedAt = at;
			fake.alive = false;
		},
	};
	return fake;
}

function makeSpawnServer(id: string) {
	let spawnCount = 0;
	const spawn = vi.fn(async () => {
		spawnCount++;
		return {
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1000 + spawnCount,
			},
		};
	});
	return {
		id,
		name: id,
		extensions: [".fake"],
		root: async () => FIXTURE_ROOT,
		spawn,
		getSpawnCount: () => spawnCount,
	};
}

describe("LSPService circuit breaker — post-init runtime exits (#1127)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("converges: N+1 early crash-loop respawns stop re-attaching and give up (fails on pre-fix unbounded respawn)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number>; clients: Map<string, unknown> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;
		const BROKEN_PERMANENT_AFTER = 5;

		// Initial spawn — no existing (dead) client yet, so this goes straight
		// through spawnClient() and never touches the breaker.
		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		clients.at(-1)!.die(); // post-init crash, right now — never called shutdown()

		// A generous bound so an unbounded-respawn regression fails the test
		// instead of looping forever: on pre-fix master this loop runs past
		// BROKEN_PERMANENT_AFTER without ever converging (permanentlyBroken never
		// gets set), and the final assertions below catch that.
		const MAX_CYCLES = BROKEN_PERMANENT_AFTER + 5;

		for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
			// Each crash cycle is two calls: the first detects the dead client
			// (counts the failure, sets the cooldown, and — because the cooldown
			// it JUST set is checked in that same call — returns undefined even
			// though the count itself moved). Simulate the cooldown elapsing
			// before it (real wall-clock waits, up to 5 minutes at the cap, would
			// make this test glacial) and confirm no respawn happens yet.
			internal.state.broken.delete(key);
			const detect = await service.getClientForFile(file);
			expect(detect).toBeUndefined();

			if (internal.permanentlyBroken.has(key)) {
				// Converged: give-up latched on this detection. No further spawn
				// attempt happens even though nothing else changed.
				break;
			}

			// Still within budget — clear the (just-set) cooldown again to reach
			// the actual respawn attempt, then kill the fresh client immediately.
			internal.state.broken.delete(key);
			const respawn = await service.getClientForFile(file);
			expect(respawn).toBeDefined();
			clients.at(-1)!.die();
		}

		expect(internal.permanentlyBroken.has(key)).toBe(true);
		expect(internal.runtimeExitCounts.get(key)).toBe(BROKEN_PERMANENT_AFTER);
		// Exactly BROKEN_PERMANENT_AFTER spawns happened before give-up — the
		// breaker converged instead of respawning on every remaining iteration.
		expect(server.getSpawnCount()).toBe(BROKEN_PERMANENT_AFTER);

		// Further calls stay given-up: no new spawn, no new client.
		const spawnCountAtGiveUp = server.getSpawnCount();
		internal.state.broken.delete(key); // even if cooldown "elapses" again
		const after = await service.getClientForFile(file);
		expect(after).toBeUndefined();
		expect(server.getSpawnCount()).toBe(spawnCountAtGiveUp);
	});

	it("counts an early death even when DETECTION is delayed hours (death time, not detection time, decides)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const client = makeFakeClient("opengrep");
		createLSPClient.mockResolvedValue(client);

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		const first = await service.getClientForFile(file);
		expect(first).toBeDefined();

		// Backdate the spawn to 3 hours ago and record death only 5s after that
		// — an early, breaker-worthy exit — but do NOT touch "now": this call's
		// getClientForFile happens in real time milliseconds later, modeling
		// detection arriving hours after the actual death (#1127's documented
		// attach-triggered respawn pattern). If lifetime were computed from
		// detection time instead of the recorded exitedAt, this would wrongly
		// read as a multi-hour healthy run and never count.
		const spawnedAtHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
		internal.state.clientSpawnedAt.set(key, spawnedAtHoursAgo);
		client.die(spawnedAtHoursAgo + 5_000);

		internal.state.broken.delete(key);
		const second = await service.getClientForFile(file);
		expect(second).toBeUndefined(); // cooldown was just set by the count below

		expect(internal.runtimeExitCounts.get(key)).toBe(1);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("does NOT count a deliberate shutdown()-driven restart toward the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		// Simulate 8 deliberate restarts (well past BROKEN_PERMANENT_AFTER=5) —
		// e.g. a resync/reopen-style path that calls shutdown() itself before
		// the client goes dead. None of these should count as failures.
		for (let i = 0; i < 8; i++) {
			internal.state.broken.delete(key);
			const result = await service.getClientForFile(file);
			expect(result).toBeDefined();
			const last = clients.at(-1)!;
			// Deliberate: our own shutdown() marks it intentional (mirrors #743
			// notify-backpressure eviction / session reset paths), and only THEN
			// does the client go dead — matches the real ordering where
			// clientShutdown() sets shutdownRequested before the process exits.
			await last.shutdown();
			last.die();
		}

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
		expect(server.getSpawnCount()).toBe(8);
	});

	it("does not count a runtime exit whose lifetime is past the early-exit threshold", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const client = makeFakeClient("opengrep");
		createLSPClient.mockResolvedValue(client);

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		const first = await service.getClientForFile(file);
		expect(first).toBeDefined();

		// Died 5 minutes after spawning (well past the 60s early-exit
		// threshold) — a genuinely long, healthy run, not a crash loop.
		const spawnedAt = internal.state.clientSpawnedAt.get(key)!;
		client.die(spawnedAt + 5 * 60_000);

		internal.state.broken.delete(key);
		const second = await service.getClientForFile(file);
		expect(second).toBeDefined();

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("does NOT double-count the REAL #743 notify-backpressure eviction path", async () => {
		// #743's recordNotifyWriteBackpressure evicts a wedged client directly
		// (removes it from state.clients + calls its shutdown() + sets its own
		// cooldown) WITHOUT ever going through the "dead client — needs
		// respawn" branch this fix touches — by the time anything looks for an
		// existing client again, there simply isn't one. This drives the REAL
		// touchFile → notify-write-timeout → eviction path (not a synthetic
		// stand-in) and confirms it neither trips runtimeExitCounts nor gets
		// misread as a crash.
		const originalBudget = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		starveBudget("PI_LENS_LSP_NOTIFY_BUDGET_MS");
		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const internal = service as unknown as {
				state: { broken: Map<string, number>; clients: Map<string, unknown> };
				runtimeExitCounts: Map<string, number>;
				permanentlyBroken: Set<string>;
			};

			const server = makeSpawnServer("opengrep");
			getServersForFileWithConfig.mockReturnValue([server]);

			const client = makeFakeClient("opengrep");
			// Every notify.open write hangs forever — withDeadline's 5ms budget
			// times it out on every touchFile call, driving the backpressure
			// streak without needing to fake a stalled real process.
			client.notify.open = vi.fn().mockReturnValue(gatedPromise().promise);
			createLSPClient.mockResolvedValue(client);

			const file = FIXTURE_FILE;
			const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

			// NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3 consecutive timeouts evict.
			for (let i = 0; i < 3; i++) {
				await service.touchFile(file, `content-${i}`, {});
			}

			// Evicted via the REAL #743 path: removed from state.clients, its own
			// shutdown() called (marking it intentional), and state.broken set to
			// the base cooldown directly — none of that is this fix's counter.
			expect(internal.state.clients.has(key)).toBe(false);
			expect(client.shutdown).toHaveBeenCalled();
			expect(client.intentional).toBe(true);
			expect(internal.state.broken.has(key)).toBe(true);

			expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
			expect(internal.permanentlyBroken.has(key)).toBe(false);
		} finally {
			if (originalBudget === undefined) {
				delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			} else {
				process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = originalBudget;
			}
		}
	});
});

/**
 * Regression coverage for #1142 (residual of #1127/#1139).
 *
 * #1139's counter only trips on CONSECUTIVE exits UNDER the 60s threshold. A
 * server that reliably dies just PAST it (~65-90s after every spawn) falls into
 * the "survived past the threshold" branch on every death — which RESETS the
 * consecutive streak — so it churns indefinitely and never trips: the exact gap
 * #1142 describes. The fix adds a SECOND, independent windowed-rate condition:
 * N (=BROKEN_PERMANENT_AFTER) non-intentional deaths within a rolling M-minute
 * window trip the breaker regardless of each death's individual lifetime.
 *
 * These tests inject controllable `clientSpawnedAt`/`exitedAt` timestamps (same
 * approach as the #1127 suite above) — never wall-clock sleeps — so the "just
 * past the threshold" lifetime and the death spacing within the window are
 * exact and non-flaky. Keys are computed via `normalizeMapKey`, never hardcoded.
 */
describe("LSPService circuit breaker — windowed-rate trip (#1142)", () => {
	const TRIP_COUNT = 5; // RUNTIME_EXIT_WINDOW_TRIP_COUNT (= BROKEN_PERMANENT_AFTER)

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("SLOW loop: a server dying just PAST the 60s threshold every spawn converges (fails on pre-fix — never trips)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clients: Map<string, unknown>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			runtimeExitWindow: Map<string, number[]>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;
		// 75s: OVER the 60s fast-path threshold (so #1139's consecutive-early
		// counter never counts a single one), UNDER the 10min sleep-gap ceiling.
		const LIFETIME_MS = 75_000;
		// ~90s between deaths → all five land inside the 15min rolling window.
		const CYCLE_SPACING_MS = 90_000;

		// A spawn clock we control; start well in the past so every death still
		// lands within one 15min window measured from the most recent death.
		let spawnAt = Date.now() - 30 * 60_000;

		// Initial spawn — no prior client, straight through spawnClient().
		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		internal.state.clientSpawnedAt.set(key, spawnAt);
		clients.at(-1)!.die(spawnAt + LIFETIME_MS); // dies at 75s, never called shutdown()

		// Each over-threshold death sets NO cooldown UNTIL the window trips, so a
		// single call both detects the dead client AND respawns — that IS the
		// churn. On pre-fix code this never changes: the loop runs the full budget
		// without ever latching permanentlyBroken (the bug). The generous bound
		// turns that unbounded churn into a failing assertion rather than a hang.
		const MAX_CYCLES = TRIP_COUNT + 5;
		for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
			if (internal.permanentlyBroken.has(key)) break;
			const result = await service.getClientForFile(file);
			if (internal.permanentlyBroken.has(key)) {
				// The tripping detection cooled down, so it returned undefined and
				// did NOT respawn.
				expect(result).toBeUndefined();
				break;
			}
			expect(result).toBeDefined(); // still churning: respawned
			spawnAt += CYCLE_SPACING_MS;
			internal.state.clientSpawnedAt.set(key, spawnAt);
			clients.at(-1)!.die(spawnAt + LIFETIME_MS);
		}

		expect(internal.permanentlyBroken.has(key)).toBe(true);
		// Every death was OVER the 60s threshold, so the consecutive-early counter
		// (#1139) never counted a single one — the windowed-rate stream alone
		// tripped. This is the assertion that FAILS on pre-fix code.
		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		// Exactly TRIP_COUNT spawns happened before give-up.
		expect(server.getSpawnCount()).toBe(TRIP_COUNT);
		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");
		const summary = getDegradationSummary();
		// The breaker records the trip exactly once, under this key. Filtered to
		// the breaker kind rather than compared against the whole summary: #1743
		// added `lsp-client-skipped-broken`, so the summary now carries a second,
		// unrelated group. Asserting the whole array would turn every future
		// ledger neighbour into a false failure here, and this test is about the
		// breaker's own double-count guard.
		expect(summary.filter((group) => group.kind === "lsp-breaker")).toEqual([
			expect.objectContaining({
				kind: "lsp-breaker",
				count: 1,
				latestReasons: [expect.objectContaining({ subject: key })],
			}),
		]);
		// The neighbour is named rather than ignored: the give-up path skipped
		// this file once, and #1743 counts that skip per (server, file).
		expect(
			summary.filter((group) => group.kind === "lsp-client-skipped-broken"),
		).toEqual([expect.objectContaining({ count: 1 })]);

		// Stays given up: no new spawn even if a cooldown "elapses".
		const spawnAtGiveUp = server.getSpawnCount();
		internal.state.broken.delete(key);
		const after = await service.getClientForFile(file);
		expect(after).toBeUndefined();
		expect(server.getSpawnCount()).toBe(spawnAtGiveUp);
	});

	it("FAST loop still trips fast: a hot (<60s) crash loop converges at exactly BROKEN_PERMANENT_AFTER — the window does not delay it", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		clients.at(-1)!.die(); // uptime ~0 — hot loop

		const MAX_CYCLES = TRIP_COUNT + 5;
		for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
			internal.state.broken.delete(key);
			const detect = await service.getClientForFile(file);
			expect(detect).toBeUndefined(); // cooldown just set by the fast-path count
			if (internal.permanentlyBroken.has(key)) break;
			internal.state.broken.delete(key);
			const respawn = await service.getClientForFile(file);
			expect(respawn).toBeDefined();
			clients.at(-1)!.die();
		}

		expect(internal.permanentlyBroken.has(key)).toBe(true);
		// #1139's fast-path trip point is unchanged: 5 consecutive early exits,
		// 5 spawns — the window did not shorten it (no early trip) nor make it wait.
		expect(internal.runtimeExitCounts.get(key)).toBe(TRIP_COUNT);
		expect(server.getSpawnCount()).toBe(TRIP_COUNT);
	});

	it("NO false trip: over-ceiling lifetimes (long healthy runs / a sleep-gap-spanning exit) never feed the window", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitWindow: Map<string, number[]>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;
		// 20min lifetime — OVER the 10min ceiling. Models either a genuinely long
		// healthy run that crashed once, or an `exitedAt - spawnedAt` inflated by a
		// Modern-Standby suspend. Neither is crash-loop churn; neither is recorded.
		const LIFETIME_MS = 20 * 60_000;

		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();

		// Well past TRIP_COUNT — an over-ceiling exit must NEVER accumulate.
		for (let cycle = 0; cycle < TRIP_COUNT + 3; cycle++) {
			const spawnAt = Date.now() - LIFETIME_MS;
			internal.state.clientSpawnedAt.set(key, spawnAt);
			clients.at(-1)!.die(spawnAt + LIFETIME_MS); // uptime = 20min, > ceiling
			internal.state.broken.delete(key);
			const result = await service.getClientForFile(file);
			expect(result).toBeDefined(); // survived-long servers keep respawning
		}

		expect(internal.runtimeExitWindow.get(key) ?? []).toHaveLength(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("NO false trip: sparse crashes age out of the rolling window (crashed twice, spaced past M, now healthy)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitWindow: Map<string, number[]>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;
		const LIFETIME_MS = 75_000; // under the ceiling — these DO get recorded

		// Two genuine short-lived crashes, spaced 20min apart (past the 15min
		// window). Anchored in the past so both deaths are real timestamps.
		const firstSpawn = Date.now() - 40 * 60_000;

		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		internal.state.clientSpawnedAt.set(key, firstSpawn);
		clients.at(-1)!.die(firstSpawn + LIFETIME_MS);

		internal.state.broken.delete(key);
		const afterFirst = await service.getClientForFile(file);
		expect(afterFirst).toBeDefined();
		expect(internal.runtimeExitWindow.get(key)).toHaveLength(1);

		// Second crash 20min after the first — outside the window from the first.
		const secondSpawn = firstSpawn + 20 * 60_000;
		internal.state.clientSpawnedAt.set(key, secondSpawn);
		clients.at(-1)!.die(secondSpawn + LIFETIME_MS);

		internal.state.broken.delete(key);
		const afterSecond = await service.getClientForFile(file);
		expect(afterSecond).toBeDefined();

		// The first death aged out: only the second remains — a rolling window, not
		// a cumulative-forever count. Nowhere near TRIP_COUNT; never trips.
		expect(internal.runtimeExitWindow.get(key)).toHaveLength(1);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("NO false trip: deliberate shutdown()-driven restarts never feed the window (past TRIP_COUNT)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			runtimeExitWindow: Map<string, number[]>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		// 8 intentional restarts (well past TRIP_COUNT=5) — user restart / config
		// reload / session change / #743 eviction all call shutdown() first. The
		// windowed trip is gated behind the same `!wasIntentional` guard as the
		// fast path, so none of these are recorded.
		for (let i = 0; i < 8; i++) {
			internal.state.broken.delete(key);
			const result = await service.getClientForFile(file);
			expect(result).toBeDefined();
			const last = clients.at(-1)!;
			await last.shutdown(); // marks intentional before death (real ordering)
			last.die();
		}

		expect(internal.runtimeExitWindow.get(key) ?? []).toHaveLength(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
		expect(server.getSpawnCount()).toBe(8);
	});

	it("outer-map hygiene (#1183): a fully-aged-out runtimeExitWindow key gets deleted, not left stale forever", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitWindow: Map<string, number[]>;
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = FIXTURE_FILE;
		const key = `opengrep:${normalizeMapKey(FIXTURE_ROOT)}`;

		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();

		// First death: a genuine early crash, 40min in the past, so it is
		// already outside the 15min rolling window by the time "now" is
		// evaluated below. This records into runtimeExitWindow (fast path).
		const firstSpawn = Date.now() - 40 * 60_000;
		internal.state.clientSpawnedAt.set(key, firstSpawn);
		clients.at(-1)!.die(firstSpawn + 5_000); // uptime 5s — early/fast-path

		internal.state.broken.delete(key);
		const detect1 = await service.getClientForFile(file);
		expect(detect1).toBeUndefined(); // cooldown just set by the fast path
		expect(internal.runtimeExitWindow.get(key)).toHaveLength(1);
		expect(internal.permanentlyBroken.has(key)).toBe(false);

		// Respawn.
		internal.state.broken.delete(key);
		const respawn = await service.getClientForFile(file);
		expect(respawn).toBeDefined();

		// Second death: lifetime OVER the 10min sleep-gap ceiling, so
		// recordRuntimeExitWindow declines to record it at all (bails before
		// touching the map) — this exercises the "survived past threshold"
		// branch without any new entry landing in runtimeExitWindow. The
		// stale first-death entry (40min old) is the only thing left in the
		// map, and it is now fully outside the 15min window.
		const secondSpawn = Date.now() - 20 * 60_000;
		internal.state.clientSpawnedAt.set(key, secondSpawn);
		clients.at(-1)!.die(secondSpawn + 15 * 60_000); // uptime 15min > ceiling

		internal.state.broken.delete(key);
		const detect2 = await service.getClientForFile(file);
		expect(detect2).toBeDefined(); // respawned — this was not a hot crash

		// The now-fully-aged-out key was dropped entirely, not left behind as
		// a stale empty/near-empty array.
		expect(internal.runtimeExitWindow.has(key)).toBe(false);
		expect(internal.runtimeExitCounts.has(key)).toBe(false);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});
});
