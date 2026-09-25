/**
 * #3158: a `false-positive`/`suppress` mark stopped contributing to the TUI
 * widget's `suppressed: N` chip as soon as ANY fresh probe of that file ran.
 *
 * The write path, from the production tool pair rather than asserted:
 * `lens_diagnostic_mark` → `reconcileWidgetDisposition` tags the file's widget
 * entry and leaves it in the store; a fresh `lens_diagnostics source=lsp` probe
 * reconciles its footer through `reconcileWidgetFromLspResult` →
 * `reconcileScanDiagnostics` → `recordDiagnostics`, which REPLACES the file's
 * entries with the list it is handed. Since #3088 that list is the FILTERED set
 * — the marked finding is not in it — so the tagged entry was deleted rather
 * than kept-and-tagged and the chip lost that file's contribution.
 *
 * Every case drives a real seam: the production `lens_diagnostic_mark` /
 * `createLensDiagnosticsTool` pair for the reported defect and the three
 * surfaces the store backs, and `markDisposition` + `recordDiagnostics` (the
 * same production functions the tools call) for the retention rule's bound and
 * its retirement arms.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import { clearAllWorkspaceDiagnosticsCaches } from "../../clients/lsp/workspace-diagnostics-cache.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	getFileDiagnosticSummaries,
	getWidgetBlockingFilesForSweep,
	importWidgetState,
	recordDiagnostics,
	reconcileStaleWidgetFiles,
	renderWidget,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "./test-utils.js";

const MESSAGE = "Type 'string' is not assignable to type 'number'.";
const OTHER_MESSAGE = "Cannot find name 'other'.";
const FILE_BODY = "const value: number = 'bad';\nexport const other = 1;\n";
/** The spelling the widget footer and mode=full render, and therefore the
 * spelling of a mark made from either. */
const CANONICAL_MARK = { rule: "typescript:2322", tool: "lsp" };
const theme = { fg: (_color: string, value: string) => value };

let cwd: string;
let filePath: string;
let previousDataDir: string | undefined;

/** One LSP finding as a real server publishes it. */
function diag(
	message: string,
	code: number,
	line: number,
	severity = 2,
): Record<string, unknown> {
	return {
		severity,
		message,
		source: "typescript",
		code,
		serverId: "typescript",
		range: {
			start: { line: line - 1, character: 6 },
			end: { line: line - 1, character: 11 },
		},
	};
}

function makeService(diags: Array<Record<string, unknown>>) {
	return {
		touchFile: vi.fn(async () => ({ diags })),
		getDiagnostics: vi.fn(async () => []),
		getCapabilitySnapshots: vi.fn(async () => []),
	};
}

type ServiceDouble = ReturnType<typeof makeService>;

async function probe(service: ServiceDouble) {
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as never,
		() => cwd,
		() => service as never,
	);
	return (await tool.execute(
		"diag-3158",
		{ source: "lsp", scope: "paths", paths: [filePath] },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function modeAll() {
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as never,
		() => cwd,
		() => undefined as never,
	);
	return (await tool.execute(
		"all-3158",
		{ mode: "all" },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function mark(params: Record<string, unknown>) {
	const markTool = createLensDiagnosticMarkTool(() => cwd);
	return (await markTool.execute("mark-3158", params, undefined, () => {}, {
		cwd,
	})) as {
		content: Array<{ text: string }>;
		isError?: boolean;
		details?: Record<string, unknown>;
	};
}

function suppressedChip(): string | undefined {
	return renderWidget(100, theme).find((line) => line.includes("suppressed:"));
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3158-"));
	filePath = path.join(cwd, "app.ts");
	fs.writeFileSync(filePath, FILE_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(cwd, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	resetProjectLensConfigCache();
	resetDegradationLedger();
	clearAllWorkspaceDiagnosticsCaches();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetDeferredForTests();
	_resetStateCacheForTests();
	resetProjectLensConfigCache();
	resetDegradationLedger();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("the widget keeps a suppressed row across a fresh probe (#3158)", () => {
	it("keeps the suppressed chip contribution across a fresh source=lsp probe", async () => {
		// Recurrence: #3158 — `recordDiagnostics` replaced the file's entries with
		// the post-#3088 FILTERED scan set, deleting the disposition-tagged row the
		// chip counts.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();
		expect(suppressedChip()).toContain("suppressed: 1");

		await probe(service);

		expect(suppressedChip()).toContain("suppressed: 1");
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({
				message: MESSAGE,
				disposition: "false-positive",
				suppressedRetained: true,
			}),
		]);
	});

	it("keeps the live finding beside the retained row and counts each once", async () => {
		// Recurrence: a retention rule that re-added the row without matching the
		// incoming set would double-count, and one that replaced the record would
		// lose the surviving live finding (#533's shape).
		const service = makeService([
			diag(MESSAGE, 2322, 1),
			diag(OTHER_MESSAGE, 2304, 2),
		]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		await probe(service);

		const stored = getFileDiagnostics(filePath) ?? [];
		expect(stored.filter((d) => d.message === MESSAGE)).toHaveLength(1);
		expect(stored.filter((d) => d.message === OTHER_MESSAGE)).toHaveLength(1);
		expect(suppressedChip()).toContain("suppressed: 1");
		const summary = getFileDiagnosticSummaries().find(
			(s) => s.filePath === filePath,
		);
		expect(summary).toMatchObject({ blocking: 0, errors: 0, warnings: 1 });
	});

	it("drops an UNTAGGED finding the fresh scan no longer reports", async () => {
		// Recurrence: the retention rule must key on the disposition tag, not on
		// "was here before" — a finding the agent FIXED has to disappear.
		const service = makeService([
			diag(MESSAGE, 2322, 1),
			diag(OTHER_MESSAGE, 2304, 2),
		]);
		await probe(service);
		expect(getFileDiagnostics(filePath)).toHaveLength(2);

		// A genuinely NEW observation: without this the probe replays the
		// workspace-diagnostics cache entry the first call wrote, so the second
		// service double would never be asked.
		clearAllWorkspaceDiagnosticsCaches();
		await probe(makeService([diag(OTHER_MESSAGE, 2304, 2)]));

		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({ message: OTHER_MESSAGE }),
		]);
		expect(suppressedChip()).toBeUndefined();
	});

	it("replaces the retained row when a scan reports that finding again", async () => {
		// Retirement (b). Reachable whenever a mark stops applying WITHOUT a mark
		// being made: a strict `false-positive` anchor hashes the marked line, so
		// rewriting it lets the probe's #3088 filter report the finding again while
		// the retained row is still in the record. Keeping both would show the
		// agent a live finding AND count it in `suppressed: N` at the same time.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		fs.writeFileSync(filePath, "const value: number = 'other';\n");
		clearAllWorkspaceDiagnosticsCaches();
		await probe(service);

		const stored = getFileDiagnostics(filePath) ?? [];
		expect(stored.filter((d) => d.message === MESSAGE)).toEqual([
			expect.not.objectContaining({ suppressedRetained: true }),
		]);
		expect(suppressedChip()).toBeUndefined();
	});
});

describe("the retained row is not live on the other two surfaces (#3158)", () => {
	it("mode=all does not report the retained row as a live finding", async () => {
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		const all = await modeAll();

		expect(all.content[0].text).not.toContain(MESSAGE);
		expect(all.details).toMatchObject({ filesChecked: 1 });
		expect(all.details?.filesWithIssues).toBeUndefined();
	});

	it("lens_diagnostic_mark reads the retained row without a live-match reanchor note", async () => {
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await probe(service);

		const again = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		expect(again.isError).toBeFalsy();
		expect(again.content[0].text).not.toContain("reanchored");
		expect(again.content[0].text).not.toContain("multiple live matches");
	});
});

describe("the retained row's lifetime is enforced (#3158)", () => {
	it("retires the retained row when the file changes on disk", async () => {
		// Retirement (a): the retained row keeps its ORIGINAL `observedAt`, so the
		// per-entry mtime gate retires it while the rows a LATER scan observed
		// survive. The later live row is what makes this discriminating — without
		// it the record-level `touchedAt` fallback drops the whole record either
		// way, and a retained row restamped to the write's own observation time
		// would outlive the change that invalidated it.
		const observedAt = Date.now() - 60_000;
		recordDiagnostics(
			filePath,
			[
				{
					tool: "lsp",
					rule: "typescript:2322",
					message: MESSAGE,
					line: 1,
					severity: "warning",
				},
			],
			1,
			observedAt,
		);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		// The scan that no longer reports the marked finding — it is retained here.
		recordDiagnostics(filePath, [], 2, observedAt);
		expect(suppressedChip()).toContain("suppressed: 1");

		const changedAt = Date.now() - 30_000;
		fs.writeFileSync(filePath, "export const value = 1;\n");
		fs.utimesSync(filePath, changedAt / 1000, changedAt / 1000);
		// A scan of the NEW content, observed after the change.
		recordDiagnostics(
			filePath,
			[
				{
					tool: "lsp",
					rule: "typescript:2304",
					message: OTHER_MESSAGE,
					line: 1,
					severity: "warning",
				},
			],
			3,
			Date.now(),
		);
		await reconcileStaleWidgetFiles();

		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({ message: OTHER_MESSAGE }),
		]);
		expect(suppressedChip()).toBeUndefined();
	});

	it("retires the retained row instead of re-arming it when its mark stops suppressing", async () => {
		// Retirement (c): a strict `false-positive` anchor hashes the marked line,
		// so rewriting that line stops the mark from applying. The next mark on the
		// file re-runs `reconcileWidgetDisposition`, which must DROP the retained
		// row — re-arming it would put a finding no scan reported back in front of
		// the agent as live. `reconcileStaleWidgetFiles` has not run in this
		// window, so the store is the only thing standing between the row and
		// `mode=all`.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await probe(service);
		expect(getFileDiagnostics(filePath)).toHaveLength(1);

		fs.writeFileSync(filePath, "const value = 1;\nexport const other = 1;\n");
		await mark({
			filePath,
			line: 2,
			message: OTHER_MESSAGE,
			rule: "typescript:2304",
			tool: "lsp",
			disposition: "false-positive",
		});

		expect(getFileDiagnostics(filePath) ?? []).toHaveLength(0);
		expect(suppressedChip()).toBeUndefined();
		const summary = getFileDiagnosticSummaries().find(
			(s) => s.filePath === filePath,
		);
		expect(summary).toMatchObject({ blocking: 0, errors: 0 });
	});

	it("caps retained rows per file and records one bounded degradation", () => {
		// Retirement (d) / AGENTS.md shape 9: retention is the one axis that can
		// hold rows a live scan no longer reports, so it carries its own cap and
		// the truncation is counted once per file, never once per row.
		const body = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`)
			.join("\n")
			.concat("\n");
		fs.writeFileSync(filePath, body);
		const findings = Array.from({ length: 20 }, (_, i) => ({
			tool: "lsp",
			rule: `typescript:${9000 + i}`,
			message: `fake finding ${i}`,
			line: i + 1,
			severity: "warning",
		}));
		recordDiagnostics(filePath, findings);
		for (const finding of findings) {
			markDisposition(
				cwd,
				{ ...finding, cwd, filePath, content: body },
				"false-positive",
			);
		}
		expect(getFileDiagnostics(filePath)).toHaveLength(20);

		// A fresh scan that reports none of them: every tagged row is a retention
		// candidate, and the cap decides how many survive.
		recordDiagnostics(filePath, []);

		expect(getFileDiagnostics(filePath)).toHaveLength(12);
		expect(suppressedChip()).toContain("suppressed: 12");
		const capped = getDegradationSummary().find(
			(group) => group.kind === "widget-suppressed-retention-capped",
		);
		expect(capped?.count).toBe(1);
		expect(capped?.latestReasons[0]?.reason).toContain("8");

		// Bounded: a second truncating write for the same file adds no new record.
		recordDiagnostics(filePath, []);
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "widget-suppressed-retention-capped",
			)?.count,
		).toBe(1);
	});

	it("carries the retained row through a session-restore round trip", async () => {
		// Lifetime: retention is content-bound, not session-bound — the mark is
		// durable and the file's mtime is on disk, so both retirement rules still
		// apply after a resume. Unlike `stale`, it is not stripped on import.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		await probe(service);

		const snapshot = JSON.parse(JSON.stringify(exportWidgetState()));
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);

		expect(suppressedChip()).toContain("suppressed: 1");
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({
				disposition: "false-positive",
				suppressedRetained: true,
			}),
		]);
	});
});

/**
 * Round 2 F1 (reviewer probe P2). `isBlocking` ignored `disposition`, so a
 * retained suppressed ERROR still answered "yes, hard stop" to every consumer
 * that asks the predicate — the footer's blocker rows, `capStoredDiagnostics`'
 * hoist (which fills the display list from the blockers FIRST, evicting a live
 * warning), and `getWidgetBlockingFilesForSweep`. The header meanwhile reads
 * the disposition-aware `countDiagnostics`, so the agent saw a red ● row under
 * a header that counted zero errors.
 */
describe("a retained suppressed row is never a blocker (#3158 round 2 F1)", () => {
	/** Twelve live warnings — exactly `MAX_STORED_DIAGNOSTICS_PER_FILE` — so a
	 * hoisted blocker must evict one of them to fit the display list. */
	const LIVE_WARNINGS = 12;

	function twelveWarningsAndOneError() {
		const diags = [diag(MESSAGE, 2322, 1, 1)];
		for (let i = 0; i < LIVE_WARNINGS; i += 1) {
			diags.push(diag(`live warning ${i}`, 3000 + i, i + 2, 2));
		}
		return makeService(diags);
	}

	beforeEach(() => {
		fs.writeFileSync(
			filePath,
			[
				"const value: number = 'bad';",
				...Array.from(
					{ length: LIVE_WARNINGS },
					(_, i) => `const w${i} = ${i};`,
				),
			].join("\n") + "\n",
		);
	});

	it("keeps the footer free of a blocker row for a retained suppressed error", async () => {
		const service = twelveWarningsAndOneError();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		await probe(service);

		const footer = renderWidget(100, theme).join("\n");
		expect(footer).toContain(`!${LIVE_WARNINGS}W`);
		expect(footer).not.toContain("●");
		expect(footer).not.toContain(MESSAGE);
		expect(suppressedChip()).toContain("suppressed: 1");
	});

	it("keeps a retained suppressed error out of the turn-end blocker sweep", async () => {
		const service = twelveWarningsAndOneError();
		await probe(service);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});

		await probe(service);

		expect(getWidgetBlockingFilesForSweep()).toEqual([]);
	});
});

/**
 * Round 2 F2 (reviewer probe P3). The retention identity keyed on `line`, so a
 * writer that re-reports the marked finding at a SHIFTED line left the retained
 * row standing beside it — one finding counted live AND in `suppressed: N`.
 * Driven through `recordDiagnostics`, the seam `clients/pipeline.ts` calls on
 * every edit: it applies no disposition filter of its own and never runs
 * `reconcileStaleWidgetFiles`, so the store is the only thing that can refuse
 * the duplicate.
 */
describe("retention identity survives a line shift (#3158 round 2 F2)", () => {
	const finding = {
		tool: "lsp",
		rule: "typescript:2322",
		message: MESSAGE,
		severity: "warning",
	};

	it("replaces the retained row when the finding re-reports at a shifted line", async () => {
		recordDiagnostics(filePath, [{ ...finding, line: 1 }], 1);
		await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		recordDiagnostics(filePath, [], 2);
		expect(suppressedChip()).toContain("suppressed: 1");

		// An edit inserts a line above; the per-edit pipeline re-reports the same
		// finding one line down.
		fs.writeFileSync(filePath, `// header\n${FILE_BODY}`);
		recordDiagnostics(filePath, [{ ...finding, line: 2 }], 3);

		const stored = getFileDiagnostics(filePath) ?? [];
		expect(stored.filter((d) => d.message === MESSAGE)).toEqual([
			expect.objectContaining({ line: 2 }),
		]);
		expect(stored[0]?.suppressedRetained).toBeUndefined();
		expect(suppressedChip()).toBeUndefined();
	});
});
