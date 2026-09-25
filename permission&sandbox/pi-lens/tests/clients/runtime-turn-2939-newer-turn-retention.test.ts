/**
 * #2939 M4 — `handleTurnEnd`'s turn-index check before `clearTurnState`.
 *
 * Recurrence prevented: `turn_end` is async and takes seconds (measured p90
 * 14 s, `HOOK_WALL_BUDGET_MS.turn_end`'s own comment), while `turn_start`
 * calls `runtime.beginTurn()` the moment the agent starts the NEXT turn. The
 * clear at the end of the handler used to run unconditionally, so a turn_end
 * that had been dispatched for turn N deleted the worklist turn N+1 had
 * already started filling — the next turn's edits reached no pipeline and no
 * findings. `turnIndexAtDispatch` is captured before the first await and
 * compared inside `clearOwnedTurnState`; PR #2897's verify measured deleting
 * that comparison green on 115 files.
 *
 * The seam is the real `handleTurnEnd`, the real `RuntimeCoordinator` and the
 * real `CacheManager`. Only the TIMING of one scanner-store read is scripted —
 * the same `ScriptedCacheManager` technique
 * `tests/clients/runtime-turn-scanner-cache-bound.test.ts` (#3274) uses, and
 * the await window where a real `turn_start` lands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager, type CacheEntry } from "../../clients/cache-manager.js";
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

/**
 * The production cache manager with a hook on the first asynchronous store
 * read — the await window a concurrent `turn_start` lands in. Nothing about
 * the store itself is faked: the read delegates to `super`.
 */
class TurnStartDuringTurnEnd extends CacheManager {
	onFirstAsyncRead: (() => void) | undefined;

	override readCacheAsync<T>(
		scanner: string,
		cwd: string,
		maxAgeMs?: number,
	): Promise<CacheEntry<T> | null> {
		const hook = this.onFirstAsyncRead;
		this.onFirstAsyncRead = undefined;
		hook?.();
		return maxAgeMs === undefined
			? super.readCacheAsync<T>(scanner, cwd)
			: super.readCacheAsync<T>(scanner, cwd, maxAgeMs);
	}
}

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

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: TurnStartDuringTurnEnd;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2939-newer-turn-");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	runtime.setTelemetryIdentity({ sessionId: "retention-session" });
	cacheManager = new TurnStartDuringTurnEnd(false);
});

afterEach(() => {
	env.cleanup();
});

function write(relative: string, content: string): string {
	const file = path.join(env.tmpDir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

describe("#2939 M4 — turn_end never clears a newer turn's worklist", () => {
	it("retains the state a concurrent turn_start began filling", async () => {
		const thisTurn = write("src/this-turn.ts", "export const a = 1;\n");
		const nextTurn = write("src/next-turn.ts", "export const b = 2;\n");
		cacheManager.addModifiedRange(
			thisTurn,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"retention-session",
		);

		// A real `turn_start` while this turn_end is awaiting its store reads:
		// `runtime.beginTurn()` advances the index, and the new turn's first edit
		// lands in the same worklist.
		cacheManager.onFirstAsyncRead = () => {
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				nextTurn,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"retention-session",
			);
		};

		await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

		// Fixture guard: the hook has to have fired, or this case proves nothing.
		expect(runtime.turnIndex).toBeGreaterThan(0);
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files).filter((key) =>
				key.endsWith("next-turn.ts"),
			),
		).toHaveLength(1);
	});

	it("still clears its own turn's state when no newer turn started", async () => {
		const thisTurn = write("src/only-turn.ts", "export const a = 1;\n");
		cacheManager.addModifiedRange(
			thisTurn,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"retention-session",
		);

		await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

		expect(cacheManager.readTurnState(env.tmpDir).files).toEqual({});
	});
});
