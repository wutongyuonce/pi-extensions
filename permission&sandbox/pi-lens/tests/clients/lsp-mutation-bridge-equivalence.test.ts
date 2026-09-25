/**
 * #2450 review round 2 — the fallback branch (mutation-bridge, taken when a
 * caller cannot thread `runtime`/`cacheManager`) must be BEHAVIORALLY
 * EQUIVALENT to the direct branch (`bookkeepLspMutation`'s own
 * `runtime.recordProjectMutation`/`cacheManager.addModifiedRange`) for the
 * same underlying write. This file drives `recordLspMutation` — the ONE
 * public seam every LSP-applied edit bookkeeps through — twice with
 * IDENTICAL `fileDetails` (same range, same `importsChanged`), once with
 * `runtime`/`cacheManager` threaded (the direct branch) and once without (the
 * bridge fallback branch, driven against a REAL registered bridge, not a
 * spy), then deep-equals every side effect a caller can observe: the
 * turn-state entry, the change-log receipt's range, the deferred-format
 * queue, and the read-guard stamp. Each surface is its own `it()` (rather
 * than one long test) so a regression in any single surface reds
 * independently instead of being masked by an earlier assertion throwing
 * first.
 *
 * Both runs use an edit on line 7 (1-based) of an 8-line fixture, never line
 * 1 — a line-1 edit's real range collides with the `{1,1}` resource-op/
 * whole-file default, which would make this comparison pass even if the
 * range plumbing were broken on either branch (#2450 review round 2, F2).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import { registerMutationBridge } from "../../clients/mutation-bridge.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const FIXTURE_LINES = [
	"const a = 1;",
	"const b = 2;",
	"const c = 3;",
	"const d = 4;",
	"const e = 5;",
	"const f = 6;",
	"hello world;",
	"const h = 8;",
];
const EDIT_LINE_1BASED = 7; // "hello world;"

function writeFixture(dir: string, name: string): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, `${FIXTURE_LINES.join("\n")}\n`, "utf-8");
	return filePath;
}

function resultsFor(filePath: string) {
	return [
		{
			descriptions: [],
			files: [filePath],
			operationTotal: 1,
			appliedOperationTotal: 1,
			appliedOperationIndexes: [0],
			operationCounts: { textEdits: 1, create: 0, rename: 0, delete: 0 },
			fileDetails: [
				{
					filePath,
					range: { start: EDIT_LINE_1BASED, end: EDIT_LINE_1BASED },
					// A tsserver organize-imports/add-import-shaped edit — exactly the
					// import-changing case F1 threads through the bridge fallback.
					importsChanged: true,
				},
			],
		},
	];
}

describe("bookkeepLspMutation — direct path and bridge fallback are equivalent (#2450 review round 2)", () => {
	let previousDataDir: string | undefined;
	let base: ReturnType<typeof setupTestEnvironment>;
	let dirDirect: string;
	let dirBridge: string;
	let fileDirect: string;
	let fileBridge: string;
	let runtimeDirect: RuntimeCoordinator;
	let runtimeBridge: RuntimeCoordinator;
	let cacheManagerDirect: CacheManager;
	let cacheManagerBridge: CacheManager;

	beforeEach(() => {
		base = setupTestEnvironment("pi-lens-2450-equiv-");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(base.tmpDir, "data");
		dirDirect = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2450-equiv-direct-"),
		);
		dirBridge = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2450-equiv-bridge-"),
		);

		// --- Direct branch: runtime + cacheManager threaded, matching how
		// tools/lsp-navigation.ts builds its context. ---
		fileDirect = writeFixture(dirDirect, "target.ts");
		runtimeDirect = new RuntimeCoordinator();
		runtimeDirect.projectRoot = dirDirect;
		runtimeDirect.setTelemetryIdentity({ sessionId: "s-2450-equiv-direct" });
		runtimeDirect.beginTurn();
		cacheManagerDirect = new CacheManager(false);
		const directContext: LspMutationContext = {
			cwd: dirDirect,
			correlationId: "equiv-direct",
			tool: "lsp_navigation:executeCommand",
			source: "lsp-execute-command",
			runtime: runtimeDirect as never,
			cacheManager: cacheManagerDirect,
			// Same shape tools/lsp-navigation.ts threads: the runtime's own real
			// ReadGuard, not a hand-rolled spy.
			readGuard: runtimeDirect.readGuard,
			emitSummary: false,
		};
		recordLspMutation(directContext, { results: resultsFor(fileDirect) });

		// --- Bridge-fallback branch: no runtime/cacheManager on the context —
		// matching clients/lsp/client.ts's synthesized fallback context — driven
		// against a REAL registered bridge (not a spy). ---
		fileBridge = writeFixture(dirBridge, "target.ts");
		runtimeBridge = new RuntimeCoordinator();
		runtimeBridge.projectRoot = dirBridge;
		runtimeBridge.setTelemetryIdentity({ sessionId: "s-2450-equiv-bridge" });
		runtimeBridge.beginTurn();
		cacheManagerBridge = new CacheManager(false);
		registerMutationBridge({
			getRuntime: () => runtimeBridge as never,
			getCacheManager: () => cacheManagerBridge,
			getProjectRoot: () => dirBridge,
			getDispatchCwd: () => dirBridge,
			countFileLines,
			isRecordable: () => true,
			dbg: () => {},
		});
		const bridgeContext: LspMutationContext = {
			cwd: dirBridge,
			correlationId: "equiv-bridge",
			tool: "lsp_navigation:executeCommand",
			source: "lsp-execute-command",
			// No runtime/cacheManager — this is what forces the bridge fallback
			// branch, exactly like clients/lsp/client.ts's synthesized
			// `telemetryContext` for a nested/no-context server-initiated
			// applyEdit.
			emitSummary: false,
		};
		recordLspMutation(bridgeContext, { results: resultsFor(fileBridge) });
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		removeTempDirSync(dirDirect);
		removeTempDirSync(dirBridge);
		base.cleanup();
	});

	it("record the same turn-state range and importsChanged on both branches", () => {
		const directFiles = cacheManagerDirect.readTurnState(dirDirect).files ?? {};
		const bridgeFiles = cacheManagerBridge.readTurnState(dirBridge).files ?? {};
		const directKeys = Object.keys(directFiles);
		const bridgeKeys = Object.keys(bridgeFiles);
		expect(directKeys).toHaveLength(1);
		expect(bridgeKeys).toHaveLength(1);
		const directEntry = directFiles[directKeys[0]];
		const bridgeEntry = bridgeFiles[bridgeKeys[0]];
		expect(directEntry.modifiedRanges).toEqual([
			{ start: EDIT_LINE_1BASED, end: EDIT_LINE_1BASED },
		]);
		expect(bridgeEntry.modifiedRanges).toEqual(directEntry.modifiedRanges);
		// F1: the bridge fallback threads the real `importsChanged` value (from
		// `AppliedWorkspaceEdit.fileDetails[].importsChanged`) instead of the
		// bridge's own historical hardcoded `false`.
		expect(directEntry.importsChanged).toBe(true);
		expect(bridgeEntry.importsChanged).toBe(true);
	});

	it("record the same change-log receipt range on both branches (source differs by design)", () => {
		// Source is EXPECTED to differ by design — bookkeepLspMutation's direct
		// path names the specific LSP operation ("lsp-execute-command"); the
		// bridge fallback carries the generic "agent-tool:<tool>" tag, because
		// it is only ever reached when the direct path structurally cannot run.
		// That is documented, intentional asymmetry, not a bug under test here.
		const directChanges = readChangesSince(dirDirect, 0);
		const bridgeChanges = readChangesSince(dirBridge, 0);
		expect(directChanges).toHaveLength(1);
		expect(bridgeChanges).toHaveLength(1);
		expect(directChanges[0].changedRange).toEqual({
			start: EDIT_LINE_1BASED,
			end: EDIT_LINE_1BASED,
		});
		expect(bridgeChanges[0].changedRange).toEqual(
			directChanges[0].changedRange,
		);
		expect(directChanges[0].source).toBe("lsp-execute-command");
		expect(bridgeChanges[0].source).toBe(
			"agent-tool:lsp_navigation:executeCommand",
		);
	});

	it("enqueue no deferred autofix/format pass on either branch (F3)", () => {
		// bookkeepLspMutation's direct path never enqueues a deferred pass for
		// an LSP-applied edit; before this round the bridge fallback always did
		// (`deferAutofix` unset defaulted to "defer"), an inequivalence this
		// asserts is gone.
		expect(runtimeDirect.pendingDeferredFormatCount).toBe(0);
		expect(runtimeBridge.pendingDeferredFormatCount).toBe(0);
	});

	it("stamp the read-guard as written on both branches", () => {
		// Both mark the file as already covered by this session's own write, so
		// an immediate re-edit is allowed with no real Read — the same OUTCOME
		// reached via each branch's own real production mechanism (direct:
		// `context.readGuard` set explicitly; bridge fallback: the bridge's
		// internal `deps.getRuntime().readGuard.recordWritten`).
		expect(runtimeDirect.readGuard.checkEdit(fileDirect).action).toBe("allow");
		expect(runtimeBridge.readGuard.checkEdit(fileBridge).action).toBe("allow");
	});

	// #2450 fix round 3 (minor): `beforeEach` above only ever exercises
	// `importsChanged: true` on a SINGLE file. Both are worth pinning
	// independently: `importsChanged: false` is the more common shape (most
	// edits don't touch import statements), and a multi-file rename is the
	// shape #2450 exists for in the first place — a regression that only
	// shows up with >1 `fileDetails` entry (e.g. an aggregation bug in
	// `uniqueDetails`, or a loop that stops after the first file) would pass
	// every test above undetected. Driven against the SAME already-mounted
	// bridge/runtime/cacheManager `beforeEach` set up (the bridge is a
	// first-wins process singleton — see `registerMutationBridge` — so a
	// second `registerMutationBridge` call in a fresh `describe` block would
	// silently be a no-op against the FIRST block's closure, not this one).
	it("record a 2-file rename with importsChanged:false identically on both branches", () => {
		const fileA_Direct = writeFixture(dirDirect, "rename-a.ts");
		const fileB_Direct = writeFixture(dirDirect, "rename-b.ts");
		const fileA_Bridge = writeFixture(dirBridge, "rename-a.ts");
		const fileB_Bridge = writeFixture(dirBridge, "rename-b.ts");

		function renameResultsFor(fileA: string, fileB: string) {
			return [
				{
					descriptions: [],
					files: [fileA, fileB],
					operationTotal: 2,
					appliedOperationTotal: 2,
					appliedOperationIndexes: [0, 1],
					operationCounts: { textEdits: 2, create: 0, rename: 0, delete: 0 },
					fileDetails: [
						{
							filePath: fileA,
							range: { start: EDIT_LINE_1BASED, end: EDIT_LINE_1BASED },
							importsChanged: false,
						},
						{
							filePath: fileB,
							range: { start: EDIT_LINE_1BASED, end: EDIT_LINE_1BASED },
							importsChanged: false,
						},
					],
				},
			];
		}

		recordLspMutation(
			{ ...directContextForReuse(), tool: "lsp_navigation:rename" },
			{ results: renameResultsFor(fileA_Direct, fileB_Direct) },
		);
		recordLspMutation(
			{ ...bridgeContextForReuse(), tool: "lsp_navigation:rename" },
			{ results: renameResultsFor(fileA_Bridge, fileB_Bridge) },
		);

		const directFiles = cacheManagerDirect.readTurnState(dirDirect).files ?? {};
		const bridgeFiles = cacheManagerBridge.readTurnState(dirBridge).files ?? {};
		// +1 for the `beforeEach`-recorded `target.ts` already in each store.
		expect(Object.keys(directFiles)).toHaveLength(3);
		expect(Object.keys(bridgeFiles)).toHaveLength(3);
		for (const name of ["rename-a.ts", "rename-b.ts"]) {
			const directKey = Object.keys(directFiles).find((k) => k.includes(name));
			const bridgeKey = Object.keys(bridgeFiles).find((k) => k.includes(name));
			expect(directKey, `direct turn-state missing ${name}`).toBeDefined();
			expect(bridgeKey, `bridge turn-state missing ${name}`).toBeDefined();
			expect(directFiles[directKey as string].importsChanged).toBe(false);
			expect(bridgeFiles[bridgeKey as string].importsChanged).toBe(false);
		}

		const directChanges = readChangesSince(dirDirect, 0);
		const bridgeChanges = readChangesSince(dirBridge, 0);
		// +1 for the `beforeEach`-recorded change already in each store.
		expect(directChanges).toHaveLength(3);
		expect(bridgeChanges).toHaveLength(3);

		function directContextForReuse(): LspMutationContext {
			return {
				cwd: dirDirect,
				correlationId: "equiv-rename-direct",
				tool: "lsp_navigation:rename",
				source: "lsp-rename",
				runtime: runtimeDirect as never,
				cacheManager: cacheManagerDirect,
				readGuard: runtimeDirect.readGuard,
				emitSummary: false,
			};
		}
		function bridgeContextForReuse(): LspMutationContext {
			return {
				cwd: dirBridge,
				correlationId: "equiv-rename-bridge",
				tool: "lsp_navigation:rename",
				source: "lsp-rename",
				emitSummary: false,
			};
		}
	});
});
