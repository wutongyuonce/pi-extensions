/**
 * #1667: multi-identifier pull diagnostics.
 *
 * A server may register `textDocument/diagnostic` several times, each with its
 * own `registerOptions.identifier` — Roslyn registers "syntax", "semantic" and
 * "analyzers" as separate diagnostic sources; vtsls does the same. Before this
 * fix `dynamicRegistrations` stored only the METHOD name, so every identifier
 * was discarded and the pull path issued exactly ONE bare
 * `textDocument/diagnostic`. Whole diagnostic categories were silently missed.
 *
 * These are connection-double tests: `state.connection.sendRequest` is a mock,
 * not a wire-protocol server. A real fake server is deliberately out of scope
 * (#1660).
 */

import { describe, expect, it, vi } from "vitest";

// Capture `lsp_typescript_diagnostic_sequence` phase records. That record is
// emitted only when a pull settles AFFIRMATIVELY (findings or an authoritative
// clean), so its presence or absence is the direct read on how a fan-out's
// outcome was classified — far more precise than timing the wait.
const { pullSettleEvents } = vi.hoisted(() => ({
	pullSettleEvents: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			if (event.phase === "lsp_typescript_diagnostic_sequence") {
				pullSettleEvents.push(event);
			}
		}),
	};
});

import {
	applyDynamicCapabilities,
	clearDiagnosticsForPath,
	clientWaitForDiagnostics,
	type LSPClientState,
	type LSPDiagnostic,
	pullDiagnosticSources,
	setupIncomingHandlers,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.cs";
const TEST_KEY = normalizeMapKey(TEST_FILE);

function pullState(): LSPClientState {
	return createMockState({
		serverId: "csharp",
		root: "/project",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "dynamic",
		},
		staticDiagnosticsMode: "push-only",
	});
}

function diagnostic(line: number, message: string): LSPDiagnostic {
	return {
		severity: 1,
		message,
		range: {
			start: { line, character: 0 },
			end: { line, character: 5 },
		},
	} as LSPDiagnostic;
}

/**
 * Drive the real `client/registerCapability` handler, so the test exercises the
 * production registration-capture path rather than poking `dynamicRegistrations`
 * by hand.
 */
function handlerFor(
	state: LSPClientState,
	method: string,
): (params: unknown) => unknown {
	const onRequest = state.connection.onRequest as unknown as {
		mock: { calls: Array<[string, (params: unknown) => unknown]> };
	};
	const entry = onRequest.mock.calls.find((call) => call[0] === method);
	if (!entry) throw new Error(`${method} handler not installed`);
	return entry[1];
}

async function register(
	state: LSPClientState,
	registrations: Array<{
		id: string;
		method: string;
		registerOptions?: Record<string, unknown>;
	}>,
): Promise<void> {
	setupIncomingHandlers(state, undefined);
	await handlerFor(state, "client/registerCapability")({ registrations });
}

async function unregister(state: LSPClientState, ids: string[]): Promise<void> {
	await handlerFor(
		state,
		"client/unregisterCapability",
	)({
		unregisterations: ids.map((id) => ({ id })),
	});
}

/** The two identifiers Roslyn-style servers register, used by most tests. */
const TWO_SOURCES = [
	{
		id: "syntax-1",
		method: "textDocument/diagnostic",
		registerOptions: { identifier: "syntax" },
	},
	{
		id: "semantic-1",
		method: "textDocument/diagnostic",
		registerOptions: { identifier: "semantic" },
	},
];

/**
 * Install a typed `textDocument/diagnostic` responder on the connection double
 * and hand back the mock so the test can read the requests that were sent.
 * The single cast is confined here: `MessageConnection.sendRequest` is
 * overloaded, so a precisely typed handler needs one bridge to assign.
 */
function installSendRequest(
	state: LSPClientState,
	handler: (method: string, params: unknown) => Promise<unknown>,
) {
	const mock = vi.fn(handler);
	state.connection.sendRequest =
		mock as unknown as typeof state.connection.sendRequest;
	return mock;
}

/** The per-source `pullResultIds` key shape: path, NUL, identifier. */
const sourceKey = (identifier: string) => `${TEST_KEY}\u0000${identifier}`;

const identifierOf = (params: unknown): string | undefined =>
	(params as { identifier?: string } | undefined)?.identifier;

const sentIdentifiers = (sendRequest: ReturnType<typeof vi.fn>) =>
	sendRequest.mock.calls
		.filter((call) => call[0] === "textDocument/diagnostic")
		.map((call) => identifierOf(call[1]));

describe("#1667 registration capture", () => {
	it("keeps identifier and workspaceDiagnostics from registerOptions", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax", workspaceDiagnostics: false },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic", workspaceDiagnostics: true },
			},
		]);

		expect(state.dynamicRegistrations.get("syntax-1")).toMatchObject({
			method: "textDocument/diagnostic",
			identifier: "syntax",
			workspaceDiagnostics: false,
		});
		expect(state.dynamicRegistrations.get("semantic-1")).toMatchObject({
			method: "textDocument/diagnostic",
			identifier: "semantic",
			workspaceDiagnostics: true,
		});
	});

	it("derives workspace-pull support from the registration flag, not the method name", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic", workspaceDiagnostics: true },
			},
		]);

		// Only `textDocument/diagnostic` was ever registered — the method-name
		// check can never see "workspace/diagnostic" here, so a true reading can
		// only come from `registerOptions.workspaceDiagnostics`.
		expect(state.workspaceDiagnosticsSupport.workspaceDiagnostics).toBe(true);
	});

	it("reports no workspace pull when every registration declares workspaceDiagnostics false", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax", workspaceDiagnostics: false },
			},
		]);
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.workspaceDiagnostics).toBe(false);
	});
});

describe("#1667 multi-identifier pull fan-out", () => {
	it("pulls EVERY registered identifier and delivers the union", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const sendRequest = installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "CS1002: ; expected")],
				};
			}
			if (id === "semantic") {
				return {
					kind: "full",
					resultId: "sem-1",
					items: [diagnostic(9, "CS0103: name 'foo' does not exist")],
				};
			}
			// The bare pull (no identifier) returns the server's default set,
			// which here overlaps the syntax source — the union must dedupe it.
			return {
				kind: "full",
				resultId: "bare-1",
				items: [diagnostic(1, "CS1002: ; expected")],
			};
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });

		const identifiers = sentIdentifiers(sendRequest);
		expect(identifiers).toContain("syntax");
		expect(identifiers).toContain("semantic");
		expect(identifiers).toContain(undefined);

		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual([
			"CS0103: name 'foo' does not exist",
			"CS1002: ; expected",
		]);
	});

	it("answers on the first useful result and merges the slow identifier in the background", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const SLOW_MS = 400;
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "fast syntax finding")],
				};
			}
			if (id === "semantic") {
				await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
				return {
					kind: "full",
					resultId: "sem-1",
					items: [diagnostic(9, "slow semantic finding")],
				};
			}
			return { kind: "full", resultId: "bare-1", items: [] };
		});

		const startedAt = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		const elapsed = Date.now() - startedAt;

		// The fast identifier's answer is delivered immediately — no wait-for-all,
		// no post-match settle delay (the #1112/#1407 latency shape).
		expect(elapsed).toBeLessThan(SLOW_MS / 2);
		expect(
			(state.documentPullDiagnostics.get(TEST_KEY) ?? []).map((d) => d.message),
		).toContain("fast syntax finding");

		// The slow loser is not dropped: it lands in the pull cache in the
		// background, so the NEXT read for this file sees it.
		await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 200));
		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual(["fast syntax finding", "slow semantic finding"]);
	});
});

describe("#1667 previousResultId inheritance is per identifier", () => {
	it("echoes each identifier's OWN previous resultId and never crosses them", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		const resultIds: Record<string, string> = {
			syntax: "syn-1",
			semantic: "sem-1",
			bare: "bare-1",
		};
		const sendRequest = installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params) ?? "bare";
			return {
				kind: "full",
				resultId: resultIds[id],
				items: [diagnostic(id === "syntax" ? 1 : 9, `${id} finding`)],
			};
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		// Let every fan-out branch finish storing before the second round.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Round two: each identifier must echo the resultId IT was given.
		sendRequest.mockClear();
		const echoed: Array<{ id: string | undefined; previous: unknown }> = [];
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			echoed.push({
				id,
				previous: (params as { previousResultId?: unknown }).previousResultId,
			});
			// "syntax" is unchanged and inherits its own stored findings;
			// "semantic" is recomputed fresh in the SAME round.
			if (id === "syntax") return { kind: "unchanged", resultId: "syn-1" };
			if (id === "semantic") {
				return {
					kind: "full",
					resultId: "sem-2",
					items: [diagnostic(9, "semantic finding v2")],
				};
			}
			return { kind: "unchanged", resultId: "bare-1" };
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await new Promise((resolve) => setTimeout(resolve, 50));

		const byIdentifier = new Map(echoed.map((e) => [e.id, e.previous]));
		expect(byIdentifier.get("syntax")).toBe("syn-1");
		expect(byIdentifier.get("semantic")).toBe("sem-1");
		expect(byIdentifier.get(undefined)).toBe("bare-1");

		// The "unchanged" syntax source kept its own finding; the freshly pulled
		// semantic source replaced only ITS finding. Nothing was wiped by the
		// other source's report.
		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual([
			"bare finding",
			"semantic finding v2",
			"syntax finding",
		]);
	});

	it("a resync clears every identifier's resultId basis, not just the bare one", async () => {
		const state = pullState();
		await register(state, [
			{
				id: "syntax-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "syntax" },
			},
			{
				id: "semantic-1",
				method: "textDocument/diagnostic",
				registerOptions: { identifier: "semantic" },
			},
		]);
		state.openDocuments.add(TEST_KEY);

		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params) ?? "bare";
			return { kind: "full", resultId: `${id}-1`, items: [] };
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect([...state.pullResultIds.values()].sort()).toEqual([
			"bare-1",
			"semantic-1",
			"syntax-1",
		]);

		clearDiagnosticsForPath(state, TEST_KEY);

		expect([...state.pullResultIds.keys()]).toEqual([]);
	});
});

// Review round (PR #1682). Each of these covers a hole the adversarial review
// probed and found real; each fails against the pre-review code.
describe("#1667 stale-write guards", () => {
	it("a late loser from an EARLIER fan-out never clobbers a newer result", async () => {
		const state = pullState();
		await register(state, TWO_SOURCES);
		state.openDocuments.add(TEST_KEY);

		const SLOW_MS = 400;
		// "semantic" is slow on the FIRST round and fast on the second, so touch
		// 2's answer is already stored when touch 1's answer finally lands. Two
		// touches this close together is the in-repo `ensureWarmForSweep` shape:
		// a warm-up touch, then the real touch ~60ms later.
		let semanticRound = 0;
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "syntax finding")],
				};
			}
			if (id === "semantic") {
				semanticRound += 1;
				if (semanticRound === 1) {
					await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
					return {
						kind: "full",
						resultId: "sem-old",
						items: [diagnostic(9, "OLD semantic")],
					};
				}
				return {
					kind: "full",
					resultId: "sem-new",
					items: [diagnostic(9, "NEW semantic")],
				};
			}
			return { kind: "full", resultId: "bare-1", items: [] };
		});

		// Touch 1 resolves on the fast syntax source; its slow semantic pull is
		// still in flight. Touch 2 follows immediately and stores fresh semantic.
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		expect(
			(state.documentPullDiagnostics.get(TEST_KEY) ?? []).map((d) => d.message),
		).toContain("NEW semantic");

		// Touch 1's semantic answer lands now. It is the stale loser and must be
		// dropped, not written over the newer result.
		await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 200));
		const messages = (state.documentPullDiagnostics.get(TEST_KEY) ?? [])
			.map((d) => d.message)
			.sort();
		expect(messages).toEqual(["NEW semantic", "syntax finding"]);
		expect(messages).not.toContain("OLD semantic");
		// The newer round's resultId basis also survives.
		expect(state.pullResultIds.get(sourceKey("semantic"))).toBe("sem-new");
	});

	it("a resync mid-flight drops the in-flight source's write instead of resurrecting the path", async () => {
		const state = pullState();
		await register(state, TWO_SOURCES);
		state.openDocuments.add(TEST_KEY);

		const SLOW_MS = 300;
		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === "syntax") {
				return {
					kind: "full",
					resultId: "syn-1",
					items: [diagnostic(1, "fast syntax finding")],
				};
			}
			if (id === "semantic") {
				await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
				return {
					kind: "full",
					resultId: "sem-1",
					items: [diagnostic(9, "slow semantic finding")],
				};
			}
			return { kind: "full", resultId: "bare-1", items: [] };
		});

		// The fast source answers and the wait returns; the slow one is in flight.
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		expect(state.documentPullDiagnostics.get(TEST_KEY)?.length).toBe(1);

		// A resync lands in that window. Everything for the path is cleared.
		clearDiagnosticsForPath(state, TEST_KEY);
		expect(state.documentPullDiagnostics.get(TEST_KEY) ?? []).toEqual([]);

		// The slow loser now returns. Its findings describe content the resync
		// replaced, so the generation guard must drop the write. Without the
		// guard it resurrects the cleared path with a stale finding.
		await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 200));
		expect(state.documentPullDiagnostics.get(TEST_KEY) ?? []).toEqual([]);
		expect(state.pullResultIds.has(sourceKey("semantic"))).toBe(false);
	});
});

describe("#1667 unregisterCapability retires a source", () => {
	it("drops the retired source's cached findings and resultId", async () => {
		const state = pullState();
		await register(state, TWO_SOURCES);
		state.openDocuments.add(TEST_KEY);

		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params);
			if (id === undefined)
				return { kind: "full", resultId: "bare-1", items: [] };
			return {
				kind: "full",
				resultId: `${id}-1`,
				items: [diagnostic(id === "syntax" ? 1 : 9, `${id} finding`)],
			};
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 2000, { pullOnly: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			(state.documentPullDiagnostics.get(TEST_KEY) ?? [])
				.map((d) => d.message)
				.sort(),
		).toEqual(["semantic finding", "syntax finding"]);

		// The server retires its semantic source (Roslyn and vtsls re-register
		// their sources on solution reload). Its findings must go with it.
		await unregister(state, ["semantic-1"]);

		expect(
			(state.documentPullDiagnostics.get(TEST_KEY) ?? []).map((d) => d.message),
		).toEqual(["syntax finding"]);
		expect(state.pullResultIds.has(sourceKey("semantic"))).toBe(false);
		expect(state.pullResultIds.get(sourceKey("syntax"))).toBe("syntax-1");
		// The retired source is no longer pulled.
		expect(pullDiagnosticSources(state)).toEqual([undefined, "syntax"]);
	});
});

// #240 across sources: one source reporting "no findings" says nothing about a
// source that FAILED to answer. The probe is the affirmative-settle record,
// which `clientWaitForDiagnostics` emits only for a `found` or `clean` outcome.
describe("#1667 a partially-errored fan-out is not clean", () => {
	/** serverId "typescript" is the only one that emits the settle record. */
	function typescriptPullState(): LSPClientState {
		const state = pullState();
		return Object.assign(state, { serverId: "typescript" });
	}

	it("records an affirmative settle when EVERY source answers clean", async () => {
		pullSettleEvents.length = 0;
		const state = typescriptPullState();
		await register(state, TWO_SOURCES);
		state.openDocuments.add(TEST_KEY);

		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			const id = identifierOf(params) ?? "bare";
			return { kind: "full", resultId: `${id}-1`, items: [] };
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 250, { pullOnly: true });

		// The control: an all-clean fan-out IS an affirmative answer, so the probe
		// below is reading a real signal rather than a permanently empty array.
		expect(pullSettleEvents.length).toBeGreaterThan(0);
	});

	it("records NO settle when one source answers clean and another throws", async () => {
		pullSettleEvents.length = 0;
		const state = typescriptPullState();
		await register(state, TWO_SOURCES);
		state.openDocuments.add(TEST_KEY);

		installSendRequest(state, async (method, params) => {
			if (method !== "textDocument/diagnostic") return undefined;
			// The bare source authoritatively reports no findings; both named
			// sources fail.
			if (identifierOf(params) === undefined) {
				return { kind: "full", resultId: "bare-1", items: [] };
			}
			throw new Error("source unavailable");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 250, { pullOnly: true });

		// Nothing may be recorded as settled: the file's semantic findings were
		// never obtained, so "clean" would be a false clean.
		expect(pullSettleEvents).toEqual([]);
		expect(state.documentPullDiagnostics.get(TEST_KEY) ?? []).toEqual([]);
	});
});
