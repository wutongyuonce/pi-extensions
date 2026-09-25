/**
 * #3183: the `suppressed: N` chip lost a mark at the file's NEXT EDIT, even
 * when the marked line was byte-identical and the mark still applied.
 *
 * #3158 retained the disposition-tagged widget row across a fresh probe but
 * left its lifetime gated on `reconcileStaleWidgetFiles`' per-entry
 * `mtimeMs > observedAt` test — a FILE-scoped identity for a question whose
 * real identity is the strict anchor's own SPAN (`lineContentHash` of the
 * marked line). Any edit to the file therefore retired the row, and nothing
 * re-created it: later scans filter the finding out (#3088) and
 * `reconcileWidgetDisposition` bails when the record is absent.
 *
 * Every case drives a production seam: the `lens_diagnostic_mark` /
 * `createLensDiagnosticsTool` pair for the reported defect, for `mode=all` and
 * for the retention-identity arm, and `reconcileStaleWidgetFiles` — the real
 * read-path sweep — for every lifetime assertion.
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
} from "../../clients/diagnostic-dispositions.js";
import { clearAllWorkspaceDiagnosticsCaches } from "../../clients/lsp/workspace-diagnostics-cache.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	importWidgetState,
	reconcileStaleWidgetFiles,
	recordDiagnostics,
	renderWidget,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "./test-utils.js";

const MESSAGE = "Type 'string' is not assignable to type 'number'.";
const OTHER_MESSAGE = "Cannot find name 'other'.";
/** Line 1 is the marked line in every case; line 2 is the unrelated one. */
const MARKED_LINE = "const value: number = 'bad';";
const FILE_BODY = `${MARKED_LINE}\nexport const other = 1;\n`;
const SECOND_MESSAGE = "Type 'string' is not assignable to type 'number' here.";
/** Two separately markable lines plus an unrelated third the edits touch. */
const THREE_LINES = `${MARKED_LINE}\nconst other: number = 'also';\nexport const tail = 1;\n`;
const CANONICAL_MARK = { rule: "typescript:2322", tool: "lsp" };
const theme = { fg: (_color: string, value: string) => value };

let cwd: string;
let filePath: string;
let previousDataDir: string | undefined;

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
		"diag-3183",
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
		"all-3183",
		{ mode: "all" },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
}

async function mark(params: Record<string, unknown>) {
	const markTool = createLensDiagnosticMarkTool(() => cwd);
	return (await markTool.execute("mark-3183", params, undefined, () => {}, {
		cwd,
	})) as { content: Array<{ text: string }>; isError?: boolean };
}

function suppressedChip(): string | undefined {
	return renderWidget(100, theme).find((line) => line.includes("suppressed:"));
}

/** Write `body` and push the file's mtime a minute into the future, so the
 * per-entry `mtimeMs > observedAt` gate sees an unambiguous change (the
 * freshness kernel carries a Windows host-clock tolerance). */
function editFile(body: string): void {
	fs.writeFileSync(filePath, body);
	const later = Date.now() + 60_000;
	fs.utimesSync(filePath, later / 1000, later / 1000);
}

async function markLineOne() {
	const marked = await mark({
		filePath,
		line: 1,
		message: MESSAGE,
		...CANONICAL_MARK,
		disposition: "false-positive",
	});
	expect(marked.isError).toBeFalsy();
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3183-"));
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

describe("a mark outlives an edit that leaves the marked line unchanged (#3183)", () => {
	it("keeps the suppressed chip when an unrelated line changes after a probe", async () => {
		// Recurrence: #3183 — the retained row's lifetime was gated on the FILE's
		// mtime, so editing line 2 retired a mark whose line 1 was byte-identical
		// and still applying, with no path back.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		editFile(`${MARKED_LINE}\nexport const other = 2;\n`);
		expect(await reconcileStaleWidgetFiles()).toBe(0);

		expect(suppressedChip()).toContain("suppressed: 1");
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({
				message: MESSAGE,
				disposition: "false-positive",
			}),
		]);
	});

	it("keeps the suppressed chip when an unrelated line changes before any probe", async () => {
		// Recurrence: #3183, the arm reachable with NO probe in between — the row
		// is disposition-tagged but not yet `suppressedRetained`, and the sweep
		// dropped the whole record because that tagged row was its only entry.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		expect(suppressedChip()).toContain("suppressed: 1");

		editFile(`${MARKED_LINE}\nexport const other = 2;\n`);
		await reconcileStaleWidgetFiles();

		expect(suppressedChip()).toContain("suppressed: 1");
	});

	it("retires the retained row when the marked line itself changes", async () => {
		// The inverse direction (AC2): the mark stopped applying, so the row must
		// go — the sweep asks the anchor, and the anchor is gone from the file.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		editFile("const value: number = 'other';\nexport const other = 1;\n");
		expect(await reconcileStaleWidgetFiles()).toBe(1);

		expect(suppressedChip()).toBeUndefined();
		expect(getFileDiagnostics(filePath)).toBeUndefined();
	});

	it("drops the record when the marked file is deleted", async () => {
		// AC2's deletion arm: no content to ask, so the record goes wholesale.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		fs.rmSync(filePath);
		expect(await reconcileStaleWidgetFiles()).toBe(1);

		expect(suppressedChip()).toBeUndefined();
		expect(getFileDiagnostics(filePath)).toBeUndefined();
	});
});

describe("mode=all never serves a retained row as live (#3183 AC3)", () => {
	it("reports no live finding once the file's mtime moved past the observation", async () => {
		// #3158 AC3, re-armed by this PR: retirement rule 1 keeps the row past the
		// file's mtime, which is exactly the state `applyCachedDispositions` answers
		// with its WEAK fallback — and a weak filter can never match a STRICT
		// `false-positive` anchor, so the row comes back KEPT. It is then a live
		// warning for any `mode=all` pass that re-tallies the kept set, which
		// happens whenever the filter drops something: here a second marked row
		// that the project's own rule policy also disables. Hence the projection
		// must not hand a disposition row over at all.
		fs.writeFileSync(filePath, THREE_LINES);
		const service = makeService([
			diag(MESSAGE, 2322, 1),
			diag(SECOND_MESSAGE, 2999, 2),
		]);
		await probe(service);
		await markLineOne();
		const second = await mark({
			filePath,
			line: 2,
			message: SECOND_MESSAGE,
			rule: "typescript:2999",
			tool: "lsp",
			disposition: "false-positive",
		});
		expect(second.isError).toBeFalsy();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 2");

		// Only line 3 changes; both marked lines are byte-identical.
		editFile(
			THREE_LINES.replace("export const tail = 1;", "export const tail = 2;"),
		);
		await reconcileStaleWidgetFiles();
		expect(suppressedChip()).toContain("suppressed: 2");
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({
				rules: { typescript: { disable: ["typescript:2999"] } },
			}),
		);
		resetProjectLensConfigCache();

		const all = await modeAll();

		expect(all.content[0].text).not.toContain(MESSAGE);
		expect(all.content[0].text).toContain("No issues across 1 file");
		// The clean branch of mode=all: it reports no file WITH issues at all,
		// which is the shape that regresses if the row is projected as live.
		expect(all.details).toMatchObject({ filesChecked: 1 });
		expect(all.details?.filesWithIssues).toBeUndefined();
		expect(all.details?.totalWarnings).toBeUndefined();
	});

	it("still reports the record's live finding beside the marked one", async () => {
		// The inverse direction: the projection must drop ONLY disposition rows. A
		// projection that dropped the record, or every row on it, would make a
		// real finding vanish from mode=all.
		const service = makeService([
			diag(MESSAGE, 2322, 1),
			diag(OTHER_MESSAGE, 2304, 2),
		]);
		await probe(service);
		await markLineOne();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		const all = await modeAll();

		expect(all.content[0].text).toContain(OTHER_MESSAGE);
		expect(all.content[0].text).not.toContain(MESSAGE);
		expect(all.details).toMatchObject({ filesWithIssues: 1, totalWarnings: 1 });
	});
});

describe("the retention identity tells two occurrences of one rule apart (#3183)", () => {
	/** Two `typescript:2322` findings with IDENTICAL normalized messages on
	 * different lines, whose line TEXT differs — so the strict anchor of the
	 * marked one does not cover the other, and a later scan still reports it. */
	const TWO_OCCURRENCES =
		"const a: number = 'aa';\nconst b: number = 'bbbb';\n";

	it("keeps the retained row when a scan reports a different occurrence", async () => {
		// Recurrence: #3183's second half (recorded on the issue as the
		// occurrence-blind retention identity). `retentionIdentity` was
		// `[tool, rule, normalizeMessage(message)]`, so the line-2 finding the
		// probe still reports matched the line-1 row the mark retained and
		// REPLACED it — the chip lost a mark that was still applying.
		fs.writeFileSync(filePath, TWO_OCCURRENCES);
		const service = makeService([
			diag(MESSAGE, 2322, 1),
			diag(MESSAGE, 2322, 2),
		]);
		await probe(service);
		expect(getFileDiagnostics(filePath)).toHaveLength(2);
		await markLineOne();
		expect(suppressedChip()).toContain("suppressed: 1");

		await probe(service);

		const stored = getFileDiagnostics(filePath) ?? [];
		expect(stored.filter((d) => d.disposition !== undefined)).toHaveLength(1);
		expect(stored.filter((d) => d.disposition === undefined)).toEqual([
			expect.objectContaining({ line: 2 }),
		]);
		expect(suppressedChip()).toContain("suppressed: 1");
	});

	it("replaces a span-less retained row on any collision, as before", async () => {
		// The coarse fallback, and the safe direction the issue names: a WEAK
		// `suppress` mark has no strict span, so a collision cannot be resolved by
		// occurrence at all. It must still REPLACE — under-count, never a phantom
		// duplicate standing beside the live finding it duplicates. Driven through
		// `recordDiagnostics`, the seam `clients/pipeline.ts` calls on every edit
		// and the only writer that can re-report a weak-suppressed finding (a
		// `source=lsp` probe's own filter drops it before the store ever sees it).
		const finding = {
			tool: "lsp",
			rule: "typescript:2322",
			message: MESSAGE,
			line: 1,
			severity: "warning",
		};
		recordDiagnostics(filePath, [finding], 1);
		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "suppress",
		});
		expect(marked.isError).toBeFalsy();
		recordDiagnostics(filePath, [], 2);
		expect(suppressedChip()).toContain("suppressed: 1");

		recordDiagnostics(filePath, [finding], 3);

		const stored = getFileDiagnostics(filePath) ?? [];
		expect(stored).toHaveLength(1);
		expect(stored[0]?.disposition).toBeUndefined();
		expect(suppressedChip()).toBeUndefined();
	});
});

describe("the anchor span travels with the disposition tag (#3183)", () => {
	it("strips a span from a row that is no longer disposition-tagged", async () => {
		// The row-level invariant behind retirement rule 1: only a TAGGED row is
		// exempt from the mtime gate. A span left on an untagged row would exempt a
		// LIVE finding from the sweep for as long as its old line text survived
		// anywhere in the file — the same defect class this PR closes, inverted.
		// Driven through `importWidgetState` because production has no writer that
		// puts a span on an untagged row; the point is that `reconcileWidgetDisposition`
		// cannot leave one behind either.
		const service = makeService([diag(OTHER_MESSAGE, 2304, 2)]);
		await probe(service);
		const snapshot = JSON.parse(
			JSON.stringify(exportWidgetState()),
		) as ReturnType<typeof exportWidgetState>;
		for (const file of snapshot.files) {
			for (const row of [...file.diagnostics, ...file.allDiagnostics]) {
				(row as unknown as Record<string, unknown>).anchorSpan = "deadbeef";
			}
		}
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);

		// Any mark on the file re-maps every row through the untagged branch.
		await markLineOne();

		expect(getFileDiagnostics(filePath)).toEqual([
			expect.not.objectContaining({ anchorSpan: expect.anything() }),
		]);
	});
});

describe("the weak arm and pre-anchor rows keep the mtime gate (#3183)", () => {
	it("retires a suppress-marked row on an unrelated edit, as before", async () => {
		// A `suppress` mark is WEAK-anchored — intent-level, with no line-content
		// span to ask — so this PR must leave its lifetime exactly where #3158 put
		// it. Exempting every disposition row from the mtime gate instead would
		// give the weak arm an axis with no content-bound retirement at all.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		const marked = await mark({
			filePath,
			line: 1,
			message: MESSAGE,
			...CANONICAL_MARK,
			disposition: "suppress",
		});
		expect(marked.isError).toBeFalsy();
		expect(suppressedChip()).toContain("suppressed: 1");

		editFile(`${MARKED_LINE}\nexport const other = 2;\n`);
		await reconcileStaleWidgetFiles();

		expect(suppressedChip()).toBeUndefined();
	});

	it("records one bounded degradation when the marked file cannot be read", async () => {
		// The fallback's own observability. Replacing the file with a DIRECTORY
		// leaves `stat` succeeding — so the sweep still reaches the read — while
		// `readFileSync` throws on every platform and for any user; a chmod fixture
		// would pass vacuously wherever the suite runs as root.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		await probe(service);
		expect(suppressedChip()).toContain("suppressed: 1");

		fs.rmSync(filePath);
		fs.mkdirSync(filePath);
		const later = Date.now() + 60_000;
		fs.utimesSync(filePath, later / 1000, later / 1000);
		await reconcileStaleWidgetFiles();

		// Fell back to the mtime gate, exactly as a pre-#3183 build would have.
		expect(suppressedChip()).toBeUndefined();
		const record = getDegradationSummary().find(
			(group) => group.kind === "widget-mark-anchor-unreadable",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.reason).toContain("under-count");

		// Bounded: a second sweep of the same file adds no new record.
		await reconcileStaleWidgetFiles();
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "widget-mark-anchor-unreadable",
			)?.count,
		).toBe(1);
	});

	it("retires a restored row that predates the anchor stamp", async () => {
		// Forward compatibility of the persisted record: a row written by a build
		// before this PR carries `disposition` but no anchor span, so there is
		// nothing to ask and the row must fall back to the mtime gate rather than
		// becoming immortal.
		const service = makeService([diag(MESSAGE, 2322, 1)]);
		await probe(service);
		await markLineOne();
		await probe(service);

		const snapshot = JSON.parse(
			JSON.stringify(exportWidgetState()),
		) as ReturnType<typeof exportWidgetState>;
		for (const file of snapshot.files) {
			for (const row of [...file.diagnostics, ...file.allDiagnostics]) {
				delete (row as unknown as Record<string, unknown>).anchorSpan;
			}
		}
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);
		expect(suppressedChip()).toContain("suppressed: 1");

		editFile(`${MARKED_LINE}\nexport const other = 2;\n`);
		await reconcileStaleWidgetFiles();

		expect(suppressedChip()).toBeUndefined();
	});
});
