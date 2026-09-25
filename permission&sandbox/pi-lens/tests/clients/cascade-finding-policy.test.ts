/**
 * #3102 member 2: `buildResolvedFoundCascadeRun` (clients/cascade-format.ts)
 * formatted a cold neighbour's ERROR diagnostics into the turn-end cascade run
 * with no disposition filter, no `.pi-lens.json` rule policy and no inline
 * `pi-lens-ignore` suppression — so a neighbour error the agent had marked
 * `false-positive` came back on the quiet-window reconcile path every time the
 * neighbour's server answered after its cascade touch skipped the in-lane wait
 * (#1023/#1444's `resolved-found` outcome).
 *
 * The chain under test is the production one, in the order index.ts wires it:
 * `reconcileOutstandingCascadeTouches` (quiet window) →
 * `buildResolvedFoundCascadeRun` → `runtime.appendCascadeRun` →
 * `handleTurnEnd` → the agent-visible turn-end findings.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
const logCascadeMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/cascade-logger.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	logCascade: (...args: unknown[]) => logCascadeMock(...args),
}));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

import { CacheManager } from "../../clients/cache-manager.js";
import { buildResolvedFoundCascadeRun } from "../../clients/cascade-format.js";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	_resetOutstandingCascadeTouchesForTests,
	recordOutstandingCascadeTouch,
	reconcileOutstandingCascadeTouches,
} from "../../clients/lsp/cascade-tier.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const MARKED_MESSAGE = "cold neighbour error the agent dismissed";
const SECOND_MARKED_MESSAGE = "second cold neighbour error the agent dismissed";
const OTHER_MESSAGE = "cold neighbour error nobody marked";
const NEIGHBOR_BODY = "const marked = 1;\nconst other = 2;\n";

/** The identity `convertLspDiagnostics` gives a primary language-server
 * finding, and therefore the spelling of a mark made on any other surface. */
const CANONICAL_MARK = { tool: "lsp", rule: "typescript:2345" };

function errorDiag(
	line: number,
	message: string,
	code: number | string = 2345,
): LSPDiagnostic {
	return {
		severity: 1,
		message,
		source: "typescript",
		code,
		range: { start: { line, character: 0 }, end: { line, character: 5 } },
	};
}

/** An ERROR published by an AUXILIARY scanner rather than the file's language
 * server. `source` is what `findAuxiliaryProfileForSource` matches on, so this
 * is the input `retagAuxiliaryDiagnostics` acts on — both for the real tool id
 * a mark anchors against and for the profile's own native suppression. */
function auxErrorDiag(
	line: number,
	message: string,
	source: string,
	code: string,
): LSPDiagnostic {
	return {
		severity: 1,
		message,
		source,
		code,
		range: { start: { line, character: 0 }, end: { line, character: 5 } },
	};
}

let env: { tmpDir: string; cleanup: () => void };
let primary: string;
let neighbor: string;
let previousDataDir: string | undefined;

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
 * The quiet-window reconcile exactly as index.ts's `onResolvedFound` runs it,
 * followed by the turn_end that delivers the appended run. Returns the
 * agent-visible turn-end content.
 */
async function reconcileAndDeliver(diags: LSPDiagnostic[]): Promise<string> {
	const runtime = new RuntimeCoordinator();
	const cacheManager = new CacheManager(false);
	recordOutstandingCascadeTouch({
		filePath: neighbor,
		serverId: "typescript",
		touchedAt: Date.now() - 50,
	});
	const outcomes = await reconcileOutstandingCascadeTouches({
		getWarmClientForFile: async () => ({
			client: {
				serverId: "typescript",
				getAllDiagnostics: () =>
					new Map([[normalizeMapKey(neighbor), { ts: Date.now(), diags }]]),
			},
		}),
	} as never);
	expect(outcomes[0]?.outcome).toBe("resolved-found");
	// #3168 F3/F9: the stamp comes from the RECONCILE OUTCOME, exactly as
	// index.ts's `onResolvedFound` receives it — not `Date.now()`. Round 2
	// hand-supplied it and then asserted the age it had just supplied, so the
	// whole plumb was untested (F9).
	const publishedAt = outcomes[0]?.publishedAt;
	const run = buildResolvedFoundCascadeRun(env.tmpDir, {
		filePath: neighbor,
		diagnostics: outcomes[0]?.diagnostics ?? [],
		...(publishedAt !== undefined ? { publishedAt } : {}),
	});
	if (run) runtime.appendCascadeRun(run);

	runtime.beginTurn();
	cacheManager.addModifiedRange(
		primary,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
	);
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
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as never);
	return (
		consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ?? ""
	);
}

/** One indeterminate cascade run — the input the coverage advisory is built
 * from. `observedAt` is omitted unless given, exactly as every production
 * indeterminate producer leaves it (only the resolved-found plumb stamps it). */
function indeterminateRun(
	filePath: string,
	detail: string,
	observedAt?: number,
): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		indeterminate: { reason: "missing_node", detail },
		...(observedAt !== undefined ? { observedAt } : {}),
	};
}

/**
 * The coverage-advisory half of the same production turn_end: append the
 * `carried` runs, cross a turn boundary so `RuntimeCoordinator.beginTurn`
 * stamps them `carriedTurns: 1`, append the `fresh` runs AFTER the boundary
 * (so they carry no stamp), then deliver. Returns the agent-visible content.
 */
async function deliverIndeterminate(
	carried: readonly CascadeRun[],
	fresh: readonly CascadeRun[] = [],
): Promise<string> {
	const runtime = new RuntimeCoordinator();
	const cacheManager = new CacheManager(false);
	for (const run of carried) runtime.appendCascadeRun(run);
	runtime.beginTurn();
	for (const run of fresh) runtime.appendCascadeRun(run);
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
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as never);
	return (
		consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ?? ""
	);
}

/** The `• <detail>: <files>` bullet lines of a rendered coverage advisory. */
function advisoryBullets(content: string): string[] {
	return content.split("\n").filter((line) => line.trimStart().startsWith("•"));
}

async function mark(params: Record<string, unknown>) {
	const { createLensDiagnosticMarkTool } =
		await import("../../tools/lens-diagnostic-mark.js");
	const markTool = createLensDiagnosticMarkTool(() => env.tmpDir);
	return markTool.execute("mark-3102", params, undefined, () => {}, {
		cwd: env.tmpDir,
	});
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-3102-cascade-");
	primary = path.join(env.tmpDir, "primary.ts");
	neighbor = path.join(env.tmpDir, "neighbor.ts");
	fs.writeFileSync(primary, "export const x = 1;\n");
	fs.writeFileSync(neighbor, NEIGHBOR_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	_resetOutstandingCascadeTouchesForTests();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	logLatency.mockClear();
	// #3168 F11/F13 add sibling cases that emit the SAME
	// `cascade_carry_rendered` record shape the F6 case asserts, so without
	// this the F6 assertion could be satisfied by a neighbour's record rather
	// than its own (shape 7 — vacuous test).
	logCascadeMock.mockClear();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetOutstandingCascadeTouchesForTests();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	removeTempDirSync(env.tmpDir);
	env.cleanup();
});

describe("cold-neighbour cascade run applies the finding policy (#3102)", () => {
	it("premise: both neighbour errors reach the agent before anything is marked", async () => {
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
		// Round 3 (R2-F1): the FALSE arm of the #1616 sentence. Without this a
		// delivery that dropped nothing could still announce
		// "suppressed by disposition: 0 finding(s)" and no case would notice.
		expect(content).not.toContain("suppressed by disposition:");
	});

	it("#3168 F2: a carried run's re-rendered blocker is labeled with its observation age", async () => {
		// The harness's beginTurn stamps the appended run carriedTurns: 1 — the
		// re-rendered blocker must carry the carry label with the run's own
		// observation age (#1444's publishedAt, threaded through the plumb).
		// Red on master's shape: neutering either cascadeCarrySuffix call site
		// removes the label and this assertion fails.
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).toContain("(carried 1 turn ·");
		const labelCount = content.match(/\(carried 1 turn ·/g) ?? [];
		expect(labelCount.length).toBe(1);
		expect(content).toContain("scanned <1m ago");
	});

	it("#3168 F4: a MIXED carried/fresh coverage bucket is left unlabeled", async () => {
		// One carried run (stamped by beginTurn) + one fresh run in the same
		// graph bucket: a Math.max suffix would attach the carry to a file that
		// was not carried (#3168 F4) — the bucket is left unlabeled.
		const content = await deliverIndeterminate(
			[indeterminateRun(neighbor, "graph degraded")],
			[indeterminateRun(primary, "graph degraded")],
		);
		expect(content).toContain("Cascade could not compute downstream impact");
		expect(content).not.toContain("(carried");
	});

	it("#3168 F6: an all-carried bucket renders the label and emits the success record", async () => {
		const content = await deliverIndeterminate([
			indeterminateRun(neighbor, "graph degraded", Date.now()),
		]);
		expect(content).toContain("(carried 1 turn · scanned <1m ago)");
		expect(logCascadeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "cascade_carry_rendered",
				metadata: expect.objectContaining({
					carriedRunsRendered: 0,
					labeledAdvisories: 1,
				}),
			}),
		);
	});

	// Recurrence this prevents (#3168 F11): round 2 applied only F4's
	// mixed-bucket half and left the `${advisory} ${suffix}` SPACE join, so an
	// all-carried bucket with two detail bullets welded the carry label onto
	// the SECOND bullet — reading as "this one file was carried" while the
	// first, carried identically, looked fresh. The blocker path has always
	// joined with a newline. The round-2 F4 case used a single detail and
	// structurally could not see it.
	it("#3168 F11: an all-carried advisory with two bullets carries the label on its own line", async () => {
		const observedAt = Date.now() - 12 * 60_000;
		const content = await deliverIndeterminate([
			indeterminateRun(neighbor, "review graph degraded", observedAt),
			indeterminateRun(
				primary,
				"changed file not in the review graph",
				observedAt,
			),
		]);
		const bullets = advisoryBullets(content);
		expect(bullets).toHaveLength(2);
		for (const bullet of bullets) expect(bullet).not.toContain("(carried");
		expect(content.split("\n")).toContain("(carried 1 turn · scanned 12m ago)");
	});

	// Recurrence this prevents (#3168 F13): the fold used
	// `Math.min(min, r.observedAt ?? Number.MAX_SAFE_INTEGER)`, so an UNSTAMPED
	// carried run fell out of the minimum and the label stated the stamped
	// run's confident age for a bucket that contains an unaged one — a
	// fabricated age, which is exactly what AC 4 forbids.
	it("#3168 F13: one unstamped carried run collapses the bucket age to the neutral wording", async () => {
		const content = await deliverIndeterminate([
			indeterminateRun(
				neighbor,
				"review graph degraded",
				Date.now() - 12 * 60_000,
			),
			indeterminateRun(primary, "changed file not in the review graph"),
		]);
		expect(content).toContain("(carried 1 turn · scan age unknown)");
		expect(content).not.toContain("scanned 12m ago");
	});

	// #3168 F13, the production-today shape: NO indeterminate-run producer
	// stamps `observedAt` (only the resolved-found plumb does), so the
	// coverage advisory's age half is `scan age unknown` on every real carry
	// — which is why the registry entry no longer promises an age. The carry
	// COUNT is still real, and a fabricated number here would violate AC 4.
	it("#3168 F13: an all-carried bucket with no stamps at all renders the carry count and the neutral age", async () => {
		const content = await deliverIndeterminate([
			indeterminateRun(neighbor, "review graph degraded"),
			indeterminateRun(primary, "changed file not in the review graph"),
		]);
		expect(content).toContain("(carried 1 turn · scan age unknown)");
		expect(content).not.toContain("scanned");
	});

	it("drops a neighbour error marked false-positive", async () => {
		const marked = await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a neighbour error marked from the cascade run's own rendering, which prints no tool", async () => {
		// The cascade line is `line N, col M rule=<rule>: <message>` — no tool
		// for the agent to pass on, and `lens_diagnostic_mark`'s `tool` is
		// optional.
		const marked = await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			rule: "typescript:2345",
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a rule the project disabled in .pi-lens.json", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2345"] } } }),
		);
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a neighbour error an inline pi-lens-ignore comment suppresses", async () => {
		fs.writeFileSync(
			neighbor,
			"// pi-lens-ignore: typescript:2345\nconst marked = 1;\nconst other = 2;\n",
		);
		const content = await reconcileAndDeliver([
			errorDiag(1, MARKED_MESSAGE),
			errorDiag(2, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("records the drop in one bounded cascade_finding_policy phase per run", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry?.phase === "cascade_finding_policy");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.filePath).toBe(neighbor);
		expect(phases[0]?.metadata).toMatchObject({
			suppressed: 1,
			total: 2,
			auxSuppressed: 0,
		});
	});

	it("emits no cascade_finding_policy phase when NEITHER counter moved", async () => {
		// Narrowed in round 2 (F1): the old wording was satisfied by an aux-only
		// drop, which is exactly the silent drop the record has to catch.
		await reconcileAndDeliver([errorDiag(0, MARKED_MESSAGE)]);
		expect(
			logLatency.mock.calls.filter(
				([entry]) =>
					(entry as { phase?: string })?.phase === "cascade_finding_policy",
			),
		).toHaveLength(0);
	});

	it("drops a neighbour error marked false-positive under the auxiliary's real tool id", async () => {
		// #3046/#3047: `retagAuxiliaryDiagnostics` is what makes the anchor say
		// `opengrep` here instead of the generic `lsp` every other surface stopped
		// using — a mark made from the widget or mode=full carries that spelling.
		const marked = await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			tool: "opengrep",
			rule: "opengrep:aux-rule",
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await reconcileAndDeliver([
			auxErrorDiag(0, MARKED_MESSAGE, "opengrep", "aux-rule"),
			auxErrorDiag(1, OTHER_MESSAGE, "opengrep", "other-rule"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("honours the auxiliary's own native nosemgrep suppression", async () => {
		// #586: the profile's own inline comment, honoured by the per-edit
		// dispatch path. These diagnostics come straight off the client cache, so
		// nothing upstream applied it — dropping here is the FIRST application,
		// and it must leave a trace rather than vanishing (#1616 / shape 10).
		fs.writeFileSync(
			neighbor,
			"const marked = 1; // nosemgrep: aux-rule\nconst other = 2;\n",
		);
		const content = await reconcileAndDeliver([
			auxErrorDiag(0, MARKED_MESSAGE, "opengrep", "aux-rule"),
			auxErrorDiag(1, OTHER_MESSAGE, "opengrep", "other-rule"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);

		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry?.phase === "cascade_finding_policy");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.metadata).toMatchObject({
			suppressed: 0,
			total: 2,
			auxSuppressed: 1,
		});
	});

	it("drops an ast-grep error on a test-file neighbour and records it", async () => {
		// ast-grep's profile carries skipTestFiles (#687/#688) — the other half of
		// the retag's drop set, on the same record.
		const testNeighbor = path.join(env.tmpDir, "neighbor.test.ts");
		fs.writeFileSync(testNeighbor, NEIGHBOR_BODY);
		neighbor = testNeighbor;
		const content = await reconcileAndDeliver([
			auxErrorDiag(0, MARKED_MESSAGE, "ast-grep", "no-eval"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);

		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry?.phase === "cascade_finding_policy");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.metadata).toMatchObject({
			suppressed: 0,
			total: 1,
			auxSuppressed: 1,
		});
	});

	it("states the drop count on the cascade delivery itself (#1616 / AC 4)", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).toContain(OTHER_MESSAGE);
		expect(content).toContain("suppressed by disposition: 1 finding(s)");
	});

	it("counts EVERY policy drop in the delivery's suppression line", async () => {
		// Round 3 (R2-F1): the interpolated VALUE, not just the sentence. The
		// single-drop case above reads the same under a hardcoded `1`, so this
		// one drops two of three and demands the 2.
		fs.writeFileSync(
			neighbor,
			"const one = 1;\nconst two = 2;\nconst three = 3;\n",
		);
		for (const [line, message, code] of [
			[1, MARKED_MESSAGE, 2345],
			[2, SECOND_MARKED_MESSAGE, 2339],
		] as const) {
			const marked = await mark({
				filePath: neighbor,
				line,
				message,
				tool: "lsp",
				rule: `typescript:${code}`,
				disposition: "false-positive",
			});
			expect(marked.isError).toBeFalsy();
		}

		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, SECOND_MARKED_MESSAGE, 2339),
			errorDiag(2, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).not.toContain(SECOND_MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
		expect(content).toContain("suppressed by disposition: 2 finding(s)");
	});

	it("builds no cascade run at all when every neighbour error was suppressed", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const content = await reconcileAndDeliver([errorDiag(0, MARKED_MESSAGE)]);
		expect(content).not.toContain("cold neighbor");
		expect(content).not.toContain(MARKED_MESSAGE);
	});

	it("keeps neighbour errors visible when the file cannot be read (fail open)", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		// A STRICT false-positive anchor hashes the finding's own line, so with
		// no content it cannot match — the finding stays VISIBLE rather than
		// being hidden on an I/O error (AGENTS.md shape 48).
		fs.rmSync(neighbor);
		fs.mkdirSync(neighbor);

		const content = await reconcileAndDeliver([errorDiag(0, MARKED_MESSAGE)]);
		expect(content).toContain(MARKED_MESSAGE);
	});
});
