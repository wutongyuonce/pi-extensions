import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	_resetForTests,
	emitLensAnalysisComplete,
	emitLensTurnFindings,
	initLensEventsGetter,
	LENS_EVENT_NAMES,
} from "../../clients/lens-events.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const waitImmediate = () => new Promise((resolve) => setImmediate(resolve));

function baseAnalysisPayload(
	overrides: Partial<Parameters<typeof emitLensAnalysisComplete>[0]> = {},
) {
	return {
		cwd: "/repo",
		filePath: "/repo/src/file.ts",
		toolName: "edit",
		model: "test-model",
		sessionId: "session-1",
		turnIndex: 2,
		writeIndex: 1,
		diagnostics: [],
		blockers: [],
		warnings: [],
		fixed: [],
		resolvedCount: 0,
		hasBlockers: false,
		fileModified: false,
		changedFiles: [],
		durationMs: 12,
		...overrides,
	};
}

describe("lens inter-extension events", () => {
	beforeEach(() => {
		_resetForTests();
		resetDegradationLedger();
	});

	afterEach(() => {
		_resetForTests();
		resetDegradationLedger();
	});

	it("resolves the live bus when a deferred emit crosses session replacement", async () => {
		const oldEmit = vi.fn((_event: string, _payload: unknown): void => {
			throw new Error("This extension ctx is stale after session replacement");
		});
		const newEmit = vi.fn((_event: string, _payload: unknown): void => {});
		let currentBus: {
			emit: (event: string, payload: unknown) => void;
			ctx: undefined;
		} = {
			emit: oldEmit,
			ctx: undefined,
		};
		initLensEventsGetter(() => currentBus);

		emitLensTurnFindings({
			cwd: "/repo",
			filePaths: [],
			sessionId: "session-1",
			turnIndex: 1,
			blockerSections: 0,
			advisorySections: 0,
			content: "after replacement",
		});
		currentBus = { emit: newEmit, ctx: undefined };
		await waitImmediate();

		expect(oldEmit).not.toHaveBeenCalled();
		expect(newEmit).toHaveBeenCalledTimes(1);
	});

	it("does not invoke a lens emitter whose paired ctx is stale", async () => {
		const emit = vi.fn();
		initLensEventsGetter(() => ({
			emit,
			ctx: {
				isIdle: () => {
					throw new Error(
						"This extension ctx is stale after session replacement",
					);
				},
			},
		}));

		emitLensTurnFindings({
			cwd: "/repo",
			filePaths: [],
			sessionId: "session-1",
			turnIndex: 1,
			blockerSections: 0,
			advisorySections: 0,
			content: "stale",
		});
		await waitImmediate();

		expect(emit).not.toHaveBeenCalled();
	});

	it("emits analysis-complete for every analysis and findings only when diagnostics exist", async () => {
		const emit = vi.fn();
		initLensEventsGetter(() => ({ emit, ctx: undefined }));

		emitLensAnalysisComplete(baseAnalysisPayload());
		await waitImmediate();

		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith(
			LENS_EVENT_NAMES.analysisComplete,
			expect.objectContaining({
				version: 1,
				source: "pi-lens",
				filePath: "/repo/src/file.ts",
				diagnostics: [],
			}),
		);

		const diagnostic: Diagnostic = {
			id: "lsp:1:1",
			message: "Type error",
			filePath: "/repo/src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "lsp",
		};

		emit.mockClear();
		emitLensAnalysisComplete(
			baseAnalysisPayload({
				diagnostics: [diagnostic],
				blockers: [diagnostic],
				hasBlockers: true,
			}),
		);
		await waitImmediate();

		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenNthCalledWith(
			1,
			LENS_EVENT_NAMES.analysisComplete,
			expect.objectContaining({ hasBlockers: true }),
		);
		expect(emit).toHaveBeenNthCalledWith(
			2,
			LENS_EVENT_NAMES.findings,
			expect.objectContaining({
				blockers: [expect.objectContaining({ tool: "lsp" })],
			}),
		);
	});

	it("emits turn-end findings with bounded content", async () => {
		const emit = vi.fn();
		initLensEventsGetter(() => ({ emit, ctx: undefined }));

		emitLensTurnFindings({
			cwd: "/repo",
			filePaths: ["/repo/src/file.ts"],
			sessionId: "session-1",
			turnIndex: 3,
			blockerSections: 1,
			advisorySections: 1,
			content: "x".repeat(9_000),
		});
		await waitImmediate();

		expect(emit).toHaveBeenCalledWith(
			LENS_EVENT_NAMES.turnFindings,
			expect.objectContaining({
				version: 1,
				source: "pi-lens",
				blockerSections: 1,
				advisorySections: 1,
				content: expect.stringMatching(/…$/),
			}),
		);
	});

	it("gates emit-failure degradation to one-per-occurrence, re-armed by a success (H1, #1415)", async () => {
		// Mirrors clients/bus-publish.ts's `hasLoggedFailure` pattern (see
		// tests/clients/bus-publish.test.ts's "logs and ledgers each stale
		// occurrence after a successful recovery"). Before this fix,
		// lens-events.ts called recordStaleBusFailure/recordDegradation
		// UNGATED on every failed emit — two consecutive failures would have
		// recorded two degradations instead of one.
		const failingEmit = vi.fn((_event: string, _payload: unknown): void => {
			throw new Error("This extension ctx is stale after session replacement");
		});
		const okEmit = vi.fn((_event: string, _payload: unknown): void => {});
		let currentEmit: typeof failingEmit = failingEmit;
		initLensEventsGetter(() => ({
			emit: (event: string, payload: unknown) => currentEmit(event, payload),
			ctx: undefined,
		}));

		const publish = (content: string) =>
			emitLensTurnFindings({
				cwd: "/repo",
				filePaths: [],
				sessionId: "session-1",
				turnIndex: 1,
				blockerSections: 0,
				advisorySections: 0,
				content,
			});

		publish("first");
		await waitImmediate();
		publish("second");
		await waitImmediate();

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 1 }),
		]);

		currentEmit = okEmit;
		publish("recovered");
		await waitImmediate();
		expect(okEmit).toHaveBeenCalledTimes(1);

		currentEmit = failingEmit;
		publish("third");
		await waitImmediate();

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({ kind: "bus-stale", count: 2 }),
		]);
	});
});
