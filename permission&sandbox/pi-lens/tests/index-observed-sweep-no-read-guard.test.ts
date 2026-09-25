/**
 * #2465 round 2 — the `agent_settled` observed-mutation SWEEP (not just the
 * mutation bridge's own recording seam) under `--no-read-guard`.
 *
 * `tests/index-mutation-bridge-recordability.test.ts` proved that a DIRECT
 * `bridge.recordMutation(...)` call under `--no-read-guard` still records
 * turn-state and the change-log receipt, skipping only the read-guard
 * staleness stamp. It never drives `index.ts`'s `runObservedSettledSweepSafely`
 * or `refreshObservedLedgerSafely` — both of which used to blanket-return
 * under `no-read-guard`, on the theory that the sweep's baseline only exists
 * because the read-guard is active.
 *
 * That theory is false: `clients/runtime-tool-call.ts`'s `recordRead` (the
 * call that seeds `collectTrackedPaths`/`storedLineHashesFor`, the sweep's
 * baseline) has no flag gate at all — only the pre-edit BLOCKING checks are
 * gated, matching `no-read-guard`'s documented meaning ("disable
 * read-before-edit behavior monitor",
 * `clients/lens-flag-registry.ts`). So under `no-read-guard` a read is still
 * recorded, the sweep still has real drift to catch, and the blanket early
 * return dropped turn-state, the change-log receipt, and the
 * `noteMutationHandled` mark right along with the read-guard stamp — the same
 * bridge-recordability conflation the first round of #2465 fixed one layer
 * down.
 *
 * This file drives the REAL production path: `session_start` → a `read`
 * `tool_call` (seeds the read-guard baseline) → `agent_settled` (seeds the
 * ledger) → an external, out-of-band `fs.writeFileSync` (a third-party
 * producer that never touches pi-lens's tool-event path or the mutation
 * bridge) → a second `agent_settled`, whose sweep must notice the drift and
 * replay it through the bridge.
 *
 * `handleAgentEnd` (the deferred autofix/format drain) is stubbed the same
 * way `tests/index-integration.test.ts` isolates drain-adjacent behavior from
 * the sweep — this file's target is `runObservedSettledSweepSafely` and
 * `refreshObservedLedgerSafely`, not the drain's own formatting.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
// Isolates the sweep/refresh under test from the deferred autofix/format
// drain, which is a different mechanism this file makes no claim about (same
// isolation `tests/index-integration.test.ts`'s `mockDrainDeps` applies).
vi.mock("../clients/runtime-agent-end.js", () => ({
	handleAgentEnd: vi.fn(async () => undefined),
}));

import { CacheManager } from "../clients/cache-manager.js";
import extension from "../index.js";
import { resetObservedMutationNet } from "../clients/observed-mutation.js";
import { normalizeFilePath } from "../clients/path-utils.js";
import { readChangesSince } from "../clients/project-changes.js";
import { ReadGuard } from "../clients/read-guard.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("#2465 round 2: the observed-mutation settled sweep runs under --no-read-guard", () => {
	let tmp: string;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2465-sweep-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		resetObservedMutationNet();
	});

	afterEach(() => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		resetObservedMutationNet();
		removeTempDirSync(tmp);
	});

	it("a third-party write under --no-read-guard is still caught by the settled sweep and replayed through the bridge, skipping only the read-guard stamp", async () => {
		// The class method every RuntimeCoordinator's lazily-constructed
		// ReadGuard shares — spying on the prototype catches the call
		// regardless of which instance index.ts's closure holds.
		const recordWrittenSpy = vi.spyOn(ReadGuard.prototype, "recordWritten");

		const pi = createPiMock({ "no-read-guard": true, "no-lsp": true });
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmp, sessionId: "s-2465-sweep" });
		await pi.emit("session_start", { reason: "startup" }, ctx);

		const filePath = path.join(tmp, "sweep-target.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");

		// Seed the read-guard's tracked-path set and per-line hash baseline
		// through the REAL production read path (recordRead is unconditional —
		// it is not gated on `no-read-guard`), exactly like an agent reading
		// the file before some external process touches it.
		await pi.emit(
			"tool_call",
			{ toolName: "read", input: { path: filePath } },
			ctx,
		);

		// First settle: nothing has drifted yet — this pass only seeds the
		// ledger's baseline for the file the read tracked.
		await pi.emit("agent_settled", {}, ctx);

		// A producer OUTSIDE pi-lens's tool-event path rewrites the file — a
		// plain fs write, exactly like a co-process extension or a background
		// formatter would, never going through the mutation bridge or a tool
		// call at all.
		fs.writeFileSync(
			filePath,
			"export const a = 2;\nexport const b = 3;\n",
			"utf-8",
		);

		// Second settle: the sweep must notice the drift and replay it through
		// the mutation bridge — this is the call the blanket `no-read-guard`
		// early return used to skip entirely.
		await pi.emit("agent_settled", {}, ctx);

		// The stamp alone is suppressed under --no-read-guard. The sweep
		// replays through the bridge with a NORMALIZED map key (`uriToPath`-
		// style forward-slash form on win32), not the raw `path.join` spelling,
		// so the comparison normalizes both sides the same way the guard's own
		// key() does (#210 — a raw-string comparison here would pass
		// vacuously regardless of whether the stamp fired).
		const stampedPaths = recordWrittenSpy.mock.calls.map((call) =>
			normalizeFilePath(String(call[0])),
		);
		expect(stampedPaths).not.toContain(normalizeFilePath(filePath));

		// Turn-state and the change-log receipt are NOT dropped — this is what
		// the blanket early return used to take down along with the stamp.
		const turnFiles = Object.keys(
			new CacheManager(false).readTurnState(tmp).files ?? {},
		);
		expect(turnFiles.some((f) => f.includes("sweep-target.ts"))).toBe(true);
		expect(readChangesSince(tmp, 0)).toContainEqual(
			expect.objectContaining({
				filePath,
				source: "agent-tool:settled-sweep",
			}),
		);
	});
});
