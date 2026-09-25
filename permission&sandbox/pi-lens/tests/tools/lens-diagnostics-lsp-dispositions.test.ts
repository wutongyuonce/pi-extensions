/**
 * #3088 (folds #3047, and the `source: "lsp"` remainder of #3041): the
 * `lens_diagnostics` `source=lsp` probe lane — the lane
 * `skills/pi-lens-lsp-navigation` steers agents to as PRIMARY — returned raw
 * LSP findings with no disposition filter, no `.pi-lens.json`
 * `rules.<id>.disable`/`select` policy and no inline `pi-lens-ignore`
 * suppression, while `mode: "delta"` and `mode: "full"` applied all three. An
 * agent that marked a finding `false-positive` and re-verified on this lane saw
 * it re-reported every turn, and the probe's own footer reconcile
 * (`reconcileWidgetFromLspResult`, which writes the pre-filter set per the #571
 * note) overwrote the mark-time demotion `reconcileWidgetDisposition` applied.
 *
 * Every case here drives the PRODUCTION tool (`createLensDiagnosticsTool` with
 * `source: "lsp"`, and the legacy `lsp_diagnostics` tool) against a real mark
 * written by the production `lens_diagnostic_mark` tool.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import {
	createCaseAliasFixture,
	removeTempDirSync,
} from "../clients/test-utils.js";

const MESSAGE = "Type 'string' is not assignable to type 'number'.";
const FILE_BODY = "const value: number = 'bad';\nexport const other = 1;\n";

let cwd: string;
let filePath: string;
let previousDataDir: string | undefined;

/**
 * A single LSP finding as a real server publishes it: `source`/`code` are the
 * identity the probe's own `formatDiag` renders, `serverId` is what the
 * workspace-diagnostics cache requires before it will persist an entry.
 */
function makeService(severity = 2) {
	const touchFile = vi.fn(async () => ({
		diags: [
			{
				severity,
				message: MESSAGE,
				source: "typescript",
				code: 2322,
				serverId: "typescript",
				range: {
					start: { line: 0, character: 6 },
					end: { line: 0, character: 11 },
				},
			},
		],
	}));
	return {
		touchFile,
		getDiagnostics: vi.fn(async () => []),
		getCapabilitySnapshots: vi.fn(async () => []),
	};
}

/** The same file carrying a SECOND, unmarked finding — so a filtered result is
 * distinguishable from an empty one and an assertion about the marked finding's
 * absence cannot pass vacuously. */
const OTHER_MESSAGE = "Cannot find name 'other'.";

function makeTwoFindingService(severity = 2, otherSeverity = severity) {
	return {
		touchFile: vi.fn(async () => ({
			diags: [
				{
					severity,
					message: MESSAGE,
					source: "typescript",
					code: 2322,
					serverId: "typescript",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 11 },
					},
				},
				{
					severity: otherSeverity,
					message: OTHER_MESSAGE,
					source: "typescript",
					code: 2304,
					serverId: "typescript",
					range: {
						start: { line: 1, character: 13 },
						end: { line: 1, character: 18 },
					},
				},
			],
		})),
		getDiagnostics: vi.fn(async () => []),
		getCapabilitySnapshots: vi.fn(async () => []),
	};
}

function makeCacheManager() {
	return { readCache: vi.fn(() => undefined) } as never;
}

type ServiceDouble = ReturnType<typeof makeService>;

async function probe(service: ServiceDouble, severity?: string) {
	const tool = createLensDiagnosticsTool(
		makeCacheManager(),
		() => cwd,
		() => service as never,
	);
	return (await tool.execute(
		"diag-3088",
		{
			source: "lsp",
			scope: "paths",
			paths: [filePath],
			...(severity === undefined ? {} : { severity }),
		},
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function legacyProbe(service: ServiceDouble) {
	const tool = createLspDiagnosticsTool(
		undefined,
		undefined,
		() => service as never,
	);
	return (await tool.execute(
		"lsp-3088",
		{ path: filePath },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

/** The single `lsp_probe_disposition_filter` record this lane emits for the
 * file, as the latency sink received it. */
function phaseMetadata(): Record<string, unknown> | undefined {
	const phases = logLatency.mock.calls
		.map(([entry]) => entry as Record<string, unknown>)
		.filter((entry) => entry.phase === "lsp_probe_disposition_filter");
	expect(phases).toHaveLength(1);
	return phases[0]?.metadata as Record<string, unknown> | undefined;
}

async function mark(params: Record<string, unknown>) {
	const markTool = createLensDiagnosticMarkTool(() => cwd);
	return markTool.execute("mark-3088", params, undefined, () => {}, { cwd });
}

/** The canonical spelling: what the widget footer / mode=full / mode=delta
 * render, and therefore the spelling of a mark made anywhere else. */
const CANONICAL_MARK = { rule: "typescript:2322", tool: "lsp" };

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3088-"));
	filePath = path.join(cwd, "app.ts");
	fs.writeFileSync(filePath, FILE_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(cwd, "data");
	logLatency.mockReset();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("lens_diagnostics source=lsp honors dispositions (#3088)", () => {
	it("drops a finding marked false-positive", async () => {
		const service = makeService();
		const before = await probe(service);
		expect(before.content[0].text).toContain(MESSAGE);

		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
		expect(after.details?.totalDiagnostics).toBe(0);
	});

	it("states the drop as a visible count instead of rendering clean (#1616)", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await probe(service);
		expect(after.content[0].text).toContain(
			"suppressed by disposition: 1 finding(s)",
		);
		expect(after.details?.dispositionSuppressed).toBe(1);
	});

	it("records one bounded lsp_probe_disposition_filter phase per filtered file", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		logLatency.mockReset();

		await probe(service);

		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry.phase === "lsp_probe_disposition_filter");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.metadata).toMatchObject({ suppressed: 1, total: 1 });
		expect(phases[0]?.filePath).toBe(filePath);
	});

	it("reports the widget's retained suppressed count on that same phase", async () => {
		// #3158 round 2 F4: retention's SUCCESS path had no record — the ledger
		// only heard about it when the per-file cap truncated. The count is folded
		// into the phase this lane already emits, so the cardinality is unchanged
		// (one per filtered file per scan), and it is live: zero on the scan that
		// first honours the mark, one once that scan's write has retained the row.
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		logLatency.mockReset();
		await probe(service);
		expect(phaseMetadata()).toMatchObject({
			suppressed: 1,
			retainedSuppressed: 0,
		});

		logLatency.mockReset();
		await probe(service);
		expect(phaseMetadata()).toMatchObject({
			suppressed: 1,
			retainedSuppressed: 1,
		});
	});

	it("emits no filter phase when nothing was dropped", async () => {
		const service = makeService();
		await probe(service);
		expect(
			logLatency.mock.calls.filter(
				([entry]) =>
					(entry as { phase?: string }).phase ===
					"lsp_probe_disposition_filter",
			),
		).toHaveLength(0);
	});

	it("drops a non-blocking finding held only by a weak suppress mark", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "suppress",
		});
		// `suppress` also writes an inline `pi-lens-ignore` comment. Restore the
		// original bytes so the ONLY thing that can drop the finding is the
		// weak-anchored store entry — otherwise this case would pass on the
		// inline filter and say nothing about the disposition.
		fs.writeFileSync(filePath, FILE_BODY);

		const after = await probe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	it("keeps a BLOCKING finding under a weak defer mark (#1625 F1)", async () => {
		const service = makeService(1);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});
		const after = await probe(service);
		expect(after.content[0].text).toContain(MESSAGE);
	});

	it("drops a deferred non-blocking finding, and resurfaces it after a session reset", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});
		expect((await probe(service)).content[0].text).not.toContain(MESSAGE);

		_resetDeferredForTests();
		expect((await probe(service)).content[0].text).toContain(MESSAGE);
	});

	it("applies the same filter, with its count, on a directory scan", async () => {
		const service = makeService();
		const tool = createLspDiagnosticsTool(
			undefined,
			undefined,
			() => service as never,
		);
		const scanDir = () =>
			tool.execute(
				"lsp-3088-dir",
				{ path: cwd },
				new AbortController().signal,
				null,
				{ cwd },
			) as Promise<{
				content: Array<{ text: string }>;
				details?: Record<string, unknown>;
			}>;

		expect((await scanDir()).content[0].text).toContain(MESSAGE);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await scanDir();
		expect(after.content[0].text).not.toContain(MESSAGE);
		expect(after.content[0].text).toContain("suppressed by disposition: 1");
		expect(after.details?.dispositionSuppressed).toBe(1);
	});

	it("keeps the surviving finding and its count when a directory scan drops only one", async () => {
		const OTHER = "Cannot find name 'other'.";
		const service = makeService();
		service.touchFile = vi.fn(async () => ({
			diags: [
				{
					severity: 2,
					message: MESSAGE,
					source: "typescript",
					code: 2322,
					serverId: "typescript",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 11 },
					},
				},
				{
					severity: 2,
					message: OTHER,
					source: "typescript",
					code: 2304,
					serverId: "typescript",
					range: {
						start: { line: 1, character: 13 },
						end: { line: 1, character: 18 },
					},
				},
			],
		}));
		const tool = createLspDiagnosticsTool(
			undefined,
			undefined,
			() => service as never,
		);
		const scanDir = () =>
			tool.execute(
				"lsp-3088-dir2",
				{ path: cwd },
				new AbortController().signal,
				null,
				{ cwd },
			) as Promise<{ content: Array<{ text: string }> }>;

		await scanDir();
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = (await scanDir()).content[0].text;
		expect(after).not.toContain(MESSAGE);
		expect(after).toContain(OTHER);
		expect(after).toContain("suppressed by disposition: 1");
	});

	it("applies the same filter on the legacy lsp_diagnostics tool", async () => {
		const service = makeService();
		await legacyProbe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const after = await legacyProbe(service);
		expect(after.content[0].text).not.toContain(MESSAGE);
		// The all-dropped arm of the single-file render still states the count.
		expect(after.content[0].text).toContain("suppressed by disposition: 1");
	});

	it("keeps the surviving finding and its count on a single-file probe", async () => {
		const OTHER = "Cannot find name 'other'.";
		const service = makeService();
		service.touchFile = vi.fn(async () => ({
			diags: [
				{
					severity: 2,
					message: MESSAGE,
					source: "typescript",
					code: 2322,
					serverId: "typescript",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 11 },
					},
				},
				{
					severity: 2,
					message: OTHER,
					source: "typescript",
					code: 2304,
					serverId: "typescript",
					range: {
						start: { line: 1, character: 13 },
						end: { line: 1, character: 18 },
					},
				},
			],
		}));
		await legacyProbe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = (await legacyProbe(service)).content[0].text;
		expect(after).not.toContain(MESSAGE);
		expect(after).toContain(OTHER);
		expect(after).toContain("suppressed by disposition: 1");
	});
});

/**
 * AGENTS.md shape 26 / #3088 AC6. The probe's own text render is
 * `[<source>] (<code>)`, while the widget footer and `mode=full` render the
 * canonical `tool: "lsp"` / `rule: "<source>:<code>"`, and
 * `lens_diagnostic_mark`'s `tool` parameter is optional. A filter that matched
 * only ONE of those spellings honored a mark made on one surface while
 * re-reporting the identical finding when the mark came from another.
 */
describe("marks converge across every spelling the surfaces render (#3088)", () => {
	const spellings: Array<[string, Record<string, unknown>]> = [
		["canonical (widget footer / mode=full)", CANONICAL_MARK],
		["probe render — [source] (code)", { tool: "typescript", rule: "2322" }],
		["rule-only, tool omitted", { rule: "typescript:2322" }],
	];

	for (const [label, identity] of spellings) {
		it(`converges for a false-positive marked with the ${label} identity`, async () => {
			const service = makeService();
			await probe(service);
			const marked = await mark({
				filePath,
				line: 1,
				message: MESSAGE,
				...identity,
				disposition: "false-positive",
			});
			expect(marked.isError).toBeFalsy();

			const after = await probe(service);
			expect(after.content[0].text).not.toContain(MESSAGE);
		});
	}
});

describe("lens_diagnostics source=lsp honors project rule policy (#3088)", () => {
	it("drops a finding whose rule is disabled in .pi-lens.json", async () => {
		const service = makeService();
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2322"] } } }),
		);
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});

	it("drops a finding outside a .pi-lens.json select allowlist", async () => {
		const service = makeService();
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { select: ["typescript:9999"] } } }),
		);
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});
});

describe("lens_diagnostics source=lsp honors inline pi-lens-ignore (#3088)", () => {
	it("drops a finding suppressed by an inline comment on the line above", async () => {
		const service = makeService();
		fs.writeFileSync(
			filePath,
			`// pi-lens-ignore: typescript:2322\n${FILE_BODY}`,
		);
		service.touchFile = vi.fn(async () => ({
			diags: [
				{
					severity: 2,
					message: MESSAGE,
					source: "typescript",
					code: 2322,
					serverId: "typescript",
					range: {
						start: { line: 1, character: 6 },
						end: { line: 1, character: 11 },
					},
				},
			],
		}));
		const result = await probe(service);
		expect(result.content[0].text).not.toContain(MESSAGE);
	});
});

/**
 * #3088 AC5. The batch sweep's workspace-diagnostics cache (#671) replays an
 * earlier observation without touching the server again. That replay is served
 * to the agent exactly like a fresh probe, so it passes the same filter — the
 * strict (`false-positive`) branch included, which needs the file's content to
 * re-derive its line hash.
 */
describe("cache-replay probes honor marks like fresh ones (#3088)", () => {
	it("drops a false-positive finding on a replay that never re-touched the server", async () => {
		const service = makeService();
		await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});

	// The cache entry records the INLINE-suppressed set, never the
	// disposition-filtered one: a mark can be revoked at any moment, and an
	// entry that baked the mark in would keep the finding hidden until the file
	// itself changed — the #571 class of stale hidden state. Mutation: record
	// `effectiveRawDiags` (already policy-filtered at that point) instead of
	// `policy.inlineKept` and this case reds.
	it("resurfaces a finding on a replay once its mark is gone from the store", async () => {
		const service = makeService();
		// The mark exists BEFORE the only fresh observation, so the cache entry
		// this probe records is the one written while the finding was filtered
		// out of the output — the case that tells `inlineKept` and `kept` apart.
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const fresh = (await probe(service)).content[0].text;
		expect(fresh).not.toContain(MESSAGE);
		// The FRESH observation is the one that filtered here — marks outlive a
		// session, so the first probe of a new session is exactly this shape — and
		// it carries its own count up to the batch render.
		expect(fresh).toContain("suppressed by disposition: 1");
		expect(service.touchFile).toHaveBeenCalledTimes(1);

		// Deleting the store is how a user revokes every persistent mark
		// (docs/dispositions.md "Storage").
		fs.rmSync(
			path.join(
				getProjectDataDir(cwd),
				"cache",
				"diagnostic-dispositions.json",
			),
		);
		_resetStateCacheForTests();

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).toContain(MESSAGE);
	});

	it("drops a weak-marked finding on a replay with no content read at all", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "defer",
		});

		const after = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(after.content[0].text).not.toContain(MESSAGE);
	});
});

/**
 * Round 2 F1. The banner tells the agent "Not a clean verdict for those
 * locations", so it has to be about locations the caller ASKED for. Counting
 * drops before the severity filter made a `severity: "error"` probe of a repo
 * carrying warning-level marks print the banner on a result that is genuinely
 * clean at that threshold — on every check, since the mark never expires.
 */
describe("the suppressed count is scoped to the requested severity (#3088 r2 F1)", () => {
	it("says nothing about a warning-level mark on a severity=error probe", async () => {
		const service = makeService(2);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		const after = await probe(service, "error");
		expect(after.details?.totalDiagnostics).toBe(0);
		expect(after.content[0].text).not.toContain("suppressed by disposition");
		expect(after.details?.dispositionSuppressed).toBeUndefined();
	});

	it("counts only the in-scope drop when a probe spans both severities", async () => {
		// An ERROR finding and a WARNING finding, both marked; a severity=error
		// probe may report exactly one drop, not two.
		const service = makeTwoFindingService(1, 2);
		await probe(service);
		for (const [message, rule] of [
			[MESSAGE, "typescript:2322"],
			[OTHER_MESSAGE, "typescript:2304"],
		] as const) {
			await mark({
				filePath,
				line: 1,
				message,
				rule,
				tool: "lsp",
				disposition: "false-positive",
			});
		}

		const after = await probe(service, "error");
		expect(after.content[0].text).toContain("suppressed by disposition: 1");
		expect(after.details?.dispositionSuppressed).toBe(1);
		// The same probe without a threshold sees both.
		const all = await probe(service);
		expect(all.details?.dispositionSuppressed).toBe(2);
	});

	it("records the in-scope count in the latency phase too", async () => {
		const service = makeTwoFindingService(1, 2);
		await probe(service);
		for (const [message, rule] of [
			[MESSAGE, "typescript:2322"],
			[OTHER_MESSAGE, "typescript:2304"],
		] as const) {
			await mark({
				filePath,
				line: 1,
				message,
				rule,
				tool: "lsp",
				disposition: "false-positive",
			});
		}
		logLatency.mockReset();

		await probe(service, "error");

		const phases = logLatency.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.filter((entry) => entry.phase === "lsp_probe_disposition_filter");
		expect(phases).toHaveLength(1);
		expect(phases[0]?.metadata).toMatchObject({ suppressed: 1, total: 1 });
	});
});

describe("the source=lsp footer reconcile respects mark-time demotion (#3088)", () => {
	it("does not re-arm a disposed finding in the widget footer", async () => {
		const service = makeService();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const demoted = getFileDiagnostics(filePath) ?? [];
		expect(demoted.some((d) => d.disposition === "false-positive")).toBe(true);

		await probe(service);

		const afterProbe = getFileDiagnostics(filePath) ?? [];
		expect(
			afterProbe.filter(
				(d) => d.message === MESSAGE && d.disposition === undefined,
			),
		).toHaveLength(0);
	});

	// Round 2 F2: the case above only reaches the REPLAY reconcile arm (its
	// second probe is served from the workspace cache). These two reach the
	// other two arms — `collectFileDiagnosticResult`'s fresh path and
	// `runFileDiagnostics` — by marking BEFORE the only observation, so the
	// probe that writes the footer is a fresh one. The second, unmarked finding
	// keeps the assertion honest: the record must hold it and only it, so
	// "marked finding absent" cannot pass on an empty record.
	it("does not re-arm a disposed finding on the batch FRESH reconcile arm", async () => {
		const service = makeTwoFindingService();
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);

		const recorded = getFileDiagnostics(filePath) ?? [];
		expect(recorded.map((d) => d.message)).toEqual([OTHER_MESSAGE]);
	});

	it("does not re-arm a disposed finding through the legacy single-file tool", async () => {
		const service = makeTwoFindingService();
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		await legacyProbe(service);

		const recorded = getFileDiagnostics(filePath) ?? [];
		expect(recorded.map((d) => d.message)).toEqual([OTHER_MESSAGE]);
	});
});

// #3160/#3182: the `paths`-mode batch (tools/lsp-diagnostics.ts:428-433,
// reached identically from the legacy `lsp_diagnostics` tool's own `paths`
// param and from `lens_diagnostics {source:"lsp", scope:"paths"}`, which
// forwards `paths` VERBATIM to the same `lspProbe` — tools/lens-diagnostics.ts
// :581, lspParams = {...params} minus source/scope) derived its per-file
// lookup key with `path.normalize` only, which folds separators/dot-segments
// but never adopts on-disk casing. `reconcileScanDiagnostics`
// (clients/widget-state.ts) records under that RAW key. A canonical writer
// (clients/pipeline.ts's ctx.filePath, or `lens_diagnostic_mark`'s own
// #3160-fixed reader) never derives that same raw key on a case-insensitive
// filesystem, so a mis-cased `paths` entry silently orphaned its own
// widget-state record — the `directory`-mode batch (tools/lsp-diagnostics.ts
// `collectFiles`, a real filesystem walk) never had this problem, since a
// directory listing already returns on-disk-accurate casing.
describe("lens_diagnostics source=lsp scope=paths / legacy lsp_diagnostics paths-mode batch widget-state key parity (#3160/#3182)", () => {
	function makeBadCallService() {
		return {
			touchFile: vi.fn(async () => ({
				diags: [
					{
						severity: 1,
						message: "bad call",
						source: "typescript",
						code: 9999,
						serverId: "typescript",
						range: {
							start: { line: 2, character: 0 },
							end: { line: 2, character: 5 },
						},
					},
				],
			})),
			getDiagnostics: vi.fn(async () => []),
			getCapabilitySnapshots: vi.fn(async () => []),
		};
	}

	it("a mis-cased paths-mode entry (lens_diagnostics source=lsp scope=paths) lets lens_diagnostic_mark reanchor under EITHER spelling", async (ctx) => {
		const fixture = createCaseAliasFixture(cwd, {
			content: "const a = 1;\nconst b = 2;\nconst target = bad();\n",
		});
		ctx.skip(fixture.skipReason !== undefined, fixture.skipReason ?? "");

		const misCasedRelative = path.relative(cwd, fixture.rawMisCased);
		const onDiskRelative = path.relative(cwd, fixture.onDisk);

		const service = makeBadCallService();
		const tool = createLensDiagnosticsTool(
			makeCacheManager(),
			() => cwd,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-3182",
			{
				source: "lsp",
				scope: "paths",
				paths: [misCasedRelative],
				severity: "all",
			},
			new AbortController().signal,
			null,
			{ cwd },
		)) as {
			content: Array<{ text: string }>;
			details?: Record<string, unknown>;
		};
		expect(result.content[0]?.text).toContain("bad call");

		const runMark = (targetFilePath: string) =>
			createLensDiagnosticMarkTool(() => cwd).execute(
				"mark-3182",
				{
					filePath: targetFilePath,
					line: 2, // stale
					message: "bad call",
					rule: "typescript:9999",
					tool: "lsp",
					disposition: "false-positive",
				},
				undefined,
				() => {},
				{ cwd },
			);

		const viaCanonical = await runMark(onDiskRelative);
		expect(viaCanonical.isError).toBeFalsy();
		expect(String(viaCanonical.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);

		const viaMisCased = await runMark(misCasedRelative);
		expect(viaMisCased.isError).toBeFalsy();
		expect(String(viaMisCased.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});

	// #3160 round 4: normalizeMapKey alone does NOT fold dot segments on POSIX
	// when the casing is already right — realpathSync.native's canonical form
	// for a dot-segment path has a DIFFERENT segment count than the raw input,
	// so adoptCanonicalCasing (a casing-only rewrite) declines and returns the
	// input unchanged. Round 3's fix relied on normalizeMapKey alone, so an
	// absolute `paths` entry carrying a `/../` segment (a legitimate shape:
	// e.g. an agent-constructed path via a relative import resolution) kept
	// its raw, un-folded spelling as the widget-state key, diverging from
	// every canonical writer/reader that resolves the SAME file to its plain
	// spelling — orphaning its own widget-state record exactly like the
	// case-folding arm this same seam already fixed.
	it("an absolute paths-mode entry with a dot segment lets lens_diagnostic_mark reanchor under the plain spelling", async () => {
		const subDir = path.join(cwd, "sub");
		fs.mkdirSync(subDir, { recursive: true });
		const plainAbs = path.join(subDir, "a.ts");
		fs.writeFileSync(
			plainAbs,
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		// Absolute, and already correctly cased — the ONLY thing wrong with it
		// is the un-folded `/../` segment. Built by string concatenation, NOT
		// `path.join`/`path.resolve` — both of those normalize dot segments
		// themselves, which would silently defeat the point of this fixture.
		const dotSegmentAbs = `${subDir}${path.sep}..${path.sep}sub${path.sep}a.ts`;
		expect(dotSegmentAbs).not.toBe(plainAbs);
		expect(fs.realpathSync.native(dotSegmentAbs)).toBe(
			fs.realpathSync.native(plainAbs),
		);

		const service = makeBadCallService();
		const tool = createLensDiagnosticsTool(
			makeCacheManager(),
			() => cwd,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-3160-r4",
			{
				source: "lsp",
				scope: "paths",
				paths: [dotSegmentAbs],
				severity: "all",
			},
			new AbortController().signal,
			null,
			{ cwd },
		)) as {
			content: Array<{ text: string }>;
			details?: Record<string, unknown>;
		};
		expect(result.content[0]?.text).toContain("bad call");

		const plainRelative = path.relative(cwd, plainAbs);
		const marked = await createLensDiagnosticMarkTool(() => cwd).execute(
			"mark-3160-r4",
			{
				filePath: plainRelative,
				line: 2, // stale
				message: "bad call",
				rule: "typescript:9999",
				tool: "lsp",
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd },
		);
		expect(marked.isError).toBeFalsy();
		expect(String(marked.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});

	// #3184 sweep: the SINGLE-`path` mode of the same tool
	// (tools/lsp-diagnostics.ts:471) derives its key with the bare
	// `path.isAbsolute(x) ? x : path.resolve(cwd, x)` shape and hands the raw
	// result to `runFileDiagnostics` → `reconcileWidgetFromLspResult` →
	// `reconcileScanDiagnostics`, which keys with `normalizeEphemeralMapKey`
	// — no `path.resolve`, no `normalizeMapKey`, so the #3184 path-utils fold
	// never reaches it. #3178 round 4 fixed the `paths` ARRAY at :444 and left
	// this sibling twenty lines away: exactly the "sweep by shape, not by
	// symbol" miss. Reached from `lens_diagnostics {source:"lsp", path}`
	// (forwarded verbatim, tools/lens-diagnostics.ts:563-573) and from the
	// legacy tool's own `path`. Dot segment built by string CONCATENATION, as
	// above.
	it("an absolute single-path entry with a dot segment lets lens_diagnostic_mark reanchor under the plain spelling (#3184)", async () => {
		const subDir = path.join(cwd, "single");
		fs.mkdirSync(subDir, { recursive: true });
		const plainAbs = path.join(subDir, "a.ts");
		fs.writeFileSync(
			plainAbs,
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		const dotSegmentAbs = `${subDir}${path.sep}..${path.sep}single${path.sep}a.ts`;
		expect(dotSegmentAbs).not.toBe(plainAbs);
		expect(fs.realpathSync.native(dotSegmentAbs)).toBe(
			fs.realpathSync.native(plainAbs),
		);

		const service = makeBadCallService();
		const tool = createLensDiagnosticsTool(
			makeCacheManager(),
			() => cwd,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-3184-single",
			{ source: "lsp", path: dotSegmentAbs, severity: "all" },
			new AbortController().signal,
			null,
			{ cwd },
		)) as {
			content: Array<{ text: string }>;
			details?: Record<string, unknown>;
		};
		expect(result.content[0]?.text).toContain("bad call");

		const marked = await createLensDiagnosticMarkTool(() => cwd).execute(
			"mark-3184-single",
			{
				filePath: path.relative(cwd, plainAbs),
				line: 2, // stale
				message: "bad call",
				rule: "typescript:9999",
				tool: "lsp",
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd },
		);
		expect(marked.isError).toBeFalsy();
		expect(String(marked.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});

	// #3184 sweep, casing half: the single-`path` mode's key must also adopt
	// on-disk casing, for the same reason the `paths` batch does (#3160/#3182)
	// — a mis-cased agent-typed `path` on a case-insensitive filesystem
	// otherwise writes a widget-state record under a spelling no canonical
	// writer or the #3160-fixed mark reader ever derives. `path.resolve` alone
	// would fold the dot segment above and leave THIS arm broken, so both
	// halves of the one expression are guarded.
	it("a mis-cased single-path entry lets lens_diagnostic_mark reanchor under EITHER spelling (#3184)", async (ctx) => {
		const fixture = createCaseAliasFixture(cwd, {
			content: "const a = 1;\nconst b = 2;\nconst target = bad();\n",
			dirName: "singlecase",
		});
		ctx.skip(fixture.skipReason !== undefined, fixture.skipReason ?? "");

		const service = makeBadCallService();
		const tool = createLensDiagnosticsTool(
			makeCacheManager(),
			() => cwd,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-3184-single-case",
			{ source: "lsp", path: fixture.rawMisCased, severity: "all" },
			new AbortController().signal,
			null,
			{ cwd },
		)) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("bad call");

		const runMark = (targetFilePath: string) =>
			createLensDiagnosticMarkTool(() => cwd).execute(
				"mark-3184-single-case",
				{
					filePath: targetFilePath,
					line: 2, // stale
					message: "bad call",
					rule: "typescript:9999",
					tool: "lsp",
					disposition: "false-positive",
				},
				undefined,
				() => {},
				{ cwd },
			);

		const viaCanonical = await runMark(path.relative(cwd, fixture.onDisk));
		expect(String(viaCanonical.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
		const viaMisCased = await runMark(path.relative(cwd, fixture.rawMisCased));
		expect(String(viaMisCased.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});
});
