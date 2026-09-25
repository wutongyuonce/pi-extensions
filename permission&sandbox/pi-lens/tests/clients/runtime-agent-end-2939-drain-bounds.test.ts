/**
 * #2939 M12 and W2 — the two `clients/runtime-agent-end.ts` guards PR #2897's
 * verify measured green under mutation.
 *
 * Recurrences prevented:
 *
 * - M12 (`const ambientSignal = signal ?? getAmbientAbortSignal()`): the
 *   deferred drain used to read the AMBIENT slot only. That slot is published
 *   by `tool_result` and cleared in its own `finally`, so at `agent_end` it is
 *   normally empty — the hook's own `ctx.signal` was the only live signal, and
 *   the drain ignored it. Escape therefore could not stop a drain already
 *   under way (#2523 AC4), and the work it had claimed was neither formatted
 *   nor requeued.
 * - W2 (the `if (!result)` block): before #2897 this was `if (!result)
 *   continue;`, so a file whose formatter exceeded the `agent_settled` budget
 *   was dropped from the queue with nothing recorded — the record was claimed,
 *   the formatter never finished, and the file was silently never formatted
 *   again. It is now counted in `summary.failed` and requeued.
 *
 * Both cases drive the real `handleAgentEnd` against the real
 * `RuntimeCoordinator` deferred queue and the real `CacheManager`; the format
 * SERVICE is the host boundary (it spawns formatter subprocesses) and is the
 * only thing scripted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
let filePath: string;

/** A format service that succeeds, or one whose format never settles. */
function formatService(mode: "succeeds" | "wedges") {
	return () =>
		({
			recordRead: () => {},
			formatFile: async (fp: string) =>
				mode === "wedges"
					? new Promise<never>(() => {})
					: {
							filePath: fp,
							formatters: ["oxfmt"],
							anyChanged: false,
							allSucceeded: true,
						},
		}) as never;
}

function deps(
	overrides: {
		signal?: AbortSignal;
		format?: "succeeds" | "wedges";
	} = {},
) {
	return {
		ctxCwd: env.tmpDir,
		getFlag: (name: string) => name === "no-lsp",
		notify: () => {},
		dbg: () => {},
		runtime,
		cacheManager,
		getFormatService: formatService(overrides.format ?? "succeeds"),
		getAutofixClients: undefined,
		...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
	} as unknown as Parameters<typeof handleAgentEnd>[0];
}

const aborted = (): AbortSignal => {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
};

beforeEach(() => {
	setAmbientAbortSignal(undefined);
	env = setupTestEnvironment("pi-lens-2939-drain-");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	cacheManager = new CacheManager(false);
	filePath = createTempFile(env.tmpDir, "drained.ts", "const x=1\n");
	runtime.deferFormat(filePath, env.tmpDir, "write", env.tmpDir);
});

afterEach(() => {
	vi.useRealTimers();
	setAmbientAbortSignal(undefined);
	env.cleanup();
});

describe("#2939 M12 — the hook's own signal governs the deferred drain", () => {
	it("requeues instead of formatting when the HOOK signal is aborted and the ambient slot is empty", async () => {
		const summary = await handleAgentEnd(deps({ signal: aborted() }));

		expect(summary?.formatted).toBe(0);
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	});

	it("formats when the hook signal is live, even though a stale ambient signal is aborted", async () => {
		// The inverse direction: the explicit signal takes precedence, so a
		// left-over ambient abort from an earlier tool_result must not cancel
		// this drain.
		setAmbientAbortSignal(aborted());
		const summary = await handleAgentEnd(
			deps({ signal: new AbortController().signal }),
		);

		expect(summary?.formatted).toBe(1);
		expect(runtime.pendingDeferredMutationCount).toBe(0);
	});

	it("still falls back to the ambient slot when the host passes no signal", async () => {
		// The other half of the `??`: an older host with no `ctx.signal` leaves
		// the ambient slot as the only signal there is, and dropping the fallback
		// would make this drain uninterruptible.
		setAmbientAbortSignal(aborted());
		const summary = await handleAgentEnd(deps());

		expect(summary?.formatted).toBe(0);
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	});
});

describe("#2939 W2 — work past the agent_settled bound is requeued, not dropped", () => {
	it("counts a formatter that blew the budget as failed and requeues its file", async () => {
		vi.useFakeTimers();
		const drain = handleAgentEnd(deps({ format: "wedges" }));
		// Let the drain's async prelude reach the format worker with the clock
		// still frozen, so the only fake time spent is the bound under test.
		await vi.advanceTimersByTimeAsync(0);
		// +1: the bound is armed inside the prelude, one tick after the freeze,
		// so its deadline lands one millisecond past the budget's nominal edge.
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		const summary = await drain;

		expect(summary?.failed).toEqual([
			{
				filePath,
				errors: ["deferred formatter exceeded agent_settled budget"],
			},
		]);
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	});
});
