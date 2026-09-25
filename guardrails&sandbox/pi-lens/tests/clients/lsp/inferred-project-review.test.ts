/**
 * #1645 review round 1 — F1 (probe channel + abort) and F4 (classifier
 * inversion).
 *
 * These pin the properties the reviewer's probes broke, not the happy path
 * (`inferred-project.test.ts` covers that).
 */
import { describe, expect, it, vi } from "vitest";
import {
	classifyProjectInfo,
	fetchTsserverProjectIdentity,
} from "../../../clients/lsp/tsserver-sync.js";
import {
	demoteInferredProjectDiagnostics,
	demoteInferredProjectSweepResults,
	INFERRED_PROJECT_PROBE_BUDGET,
	INFERRED_PROJECT_MARKER,
} from "../../../clients/lsp/inferred-project.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";

const CWD = "/proj";

function tsError(): LSPDiagnostic {
	return {
		severity: 1,
		message: "Cannot find name 'describe'.",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
		source: "typescript",
		code: 2582,
	};
}

const INFERRED_BODY = { configFileName: "/dev/null/inferredProject1*" };

// ── F4: classifier must not key off user-controlled directory names ──────────

describe("classifyProjectInfo — sentinel anchoring (#1645 F4)", () => {
	it("does NOT call a real project inferred because a directory is named inferred-project", () => {
		const identity = classifyProjectInfo({
			configFileName: "/repo/packages/inferred-project/tsconfig.json",
		});
		expect(identity.projectKind).toBe("configured");
	});

	it("does NOT demote genuine errors in an inferred-project-named directory", async () => {
		const service = {
			executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
				executed: true,
				result: {
					success: true,
					body: {
						configFileName: "/repo/inferred_project/tsconfig.json",
					},
				},
			})),
		};
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/repo/inferred_project/src/a.ts",
			cwd: "/repo",
			service,
		});
		expect(out[0].severity).toBe(1);
		expect(out[0].message).not.toContain(INFERRED_PROJECT_MARKER);
	});

	it("still recognises tsserver's real sentinel", () => {
		expect(classifyProjectInfo(INFERRED_BODY).projectKind).toBe("inferred");
		expect(
			classifyProjectInfo({ configFileName: "/dev/null/inferredProject7*" })
				.projectKind,
		).toBe("inferred");
	});

	it("treats a bare inferredProject path with no /dev/null sentinel as unknown", () => {
		// A path that merely ENDS in the placeholder name, without the sentinel
		// prefix, is not tsserver's marker and must not gate authority.
		expect(
			classifyProjectInfo({ configFileName: "/repo/inferredProject1*" })
				.projectKind,
		).toBe("unassociated");
	});
});

// ── F1a: the probe must use the read-only channel, never the mutation one ────

describe("fetchTsserverProjectIdentity — probe channel (#1645 F1)", () => {
	it("never touches the mutation channel", async () => {
		const executeCommand = vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		}));
		const executeReadOnlyCommandOnLiveClient = vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		}));
		const identity = await fetchTsserverProjectIdentity(
			{
				executeCommand,
				executeReadOnlyCommandOnLiveClient,
				getAdvertisedCommands: vi.fn(async () => [
					"typescript.tsserverRequest",
				]),
			},
			"/proj/tests/a.test.ts",
		);
		expect(identity?.projectKind).toBe("inferred");
		expect(executeReadOnlyCommandOnLiveClient).toHaveBeenCalledTimes(1);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("does NOT pre-flight getAdvertisedCommands — that helper spawns", async () => {
		const getAdvertisedCommands = vi.fn(async () => [
			"typescript.tsserverRequest",
		]);
		await fetchTsserverProjectIdentity(
			{
				getAdvertisedCommands,
				// Present so the pre-fix code path is actually REACHED — without it
				// the old implementation bailed before ever consulting the
				// advertisement helper and this test would pass vacuously.
				executeCommand: vi.fn(async () => ({
					executed: true,
					result: { success: true, body: INFERRED_BODY },
				})),
				executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
					executed: true,
					result: { success: true, body: INFERRED_BODY },
				})),
			},
			"/proj/tests/a.test.ts",
		);
		expect(getAdvertisedCommands).not.toHaveBeenCalled();
	});

	it("is UNKNOWN, not a fallback, for a service with only the mutation channel", async () => {
		const executeCommand = vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		}));
		const identity = await fetchTsserverProjectIdentity(
			{
				executeCommand,
				getAdvertisedCommands: vi.fn(async () => [
					"typescript.tsserverRequest",
				]),
			},
			"/proj/tests/a.test.ts",
		);
		expect(identity).toBeUndefined();
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("leaves an in-flight mutation's context untouched", async () => {
		// Models client.ts's mutation bookkeeping: the mutation channel nests
		// depth and wipes the context at depth > 1, exactly as runServerCommand
		// does. A probe routed through it clobbers a concurrent real command.
		const state = { depth: 0, context: undefined as string | undefined };
		const service = {
			executeCommand: vi.fn(async () => {
				state.depth += 1;
				if (state.depth > 1) state.context = undefined;
				try {
					return {
						executed: true,
						result: { success: true, body: INFERRED_BODY },
					};
				} finally {
					state.depth -= 1;
				}
			}),
			executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
				executed: true,
				result: { success: true, body: INFERRED_BODY },
			})),
		};
		// A real mutation is in flight.
		state.depth = 1;
		state.context = "rename-correlation-1";

		await fetchTsserverProjectIdentity(service, "/proj/tests/a.test.ts");

		expect(state.context).toBe("rename-correlation-1");
		expect(state.depth).toBe(1);
	});
});

// ── F1b: the sweep loop must honor the caller's abort signal ─────────────────

describe("demoteInferredProjectSweepResults — abort (#1645 F1)", () => {
	function makeService() {
		return {
			executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
				executed: true,
				result: { success: true, body: INFERRED_BODY },
			})),
		};
	}

	it("stops probing once the caller aborts", async () => {
		const service = makeService();
		const controller = new AbortController();
		let probes = 0;
		service.executeReadOnlyCommandOnLiveClient.mockImplementation(async () => {
			probes += 1;
			if (probes === 2) controller.abort();
			return { executed: true, result: { success: true, body: INFERRED_BODY } };
		});
		const results = Array.from({ length: 40 }, (_, i) => ({
			filePath: `/proj/tests/unit/a${i}.test.ts`,
			diagnostics: [tsError()],
		}));

		await demoteInferredProjectSweepResults(
			results,
			CWD,
			service,
			controller.signal,
		);

		expect(probes).toBe(2);
		expect(probes).toBeLessThan(INFERRED_PROJECT_PROBE_BUDGET);
	});

	it("carries post-abort results through unchanged rather than dropping them", async () => {
		const service = {
			...makeService(),
			// Present so the pre-fix implementation (which gated on this channel)
			// reaches the loop instead of returning early — otherwise this test
			// would pass vacuously against the code it is meant to pin.
			executeCommand: vi.fn(async () => ({
				executed: true,
				result: { success: true, body: INFERRED_BODY },
			})),
		};
		const controller = new AbortController();
		controller.abort();
		const results = [
			{ filePath: "/proj/tests/unit/a.test.ts", diagnostics: [tsError()] },
		];
		const out = await demoteInferredProjectSweepResults(
			results,
			CWD,
			service,
			controller.signal,
		);
		expect(out).toHaveLength(1);
		expect(out[0].diagnostics[0].severity).toBe(1);
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
	});
});
