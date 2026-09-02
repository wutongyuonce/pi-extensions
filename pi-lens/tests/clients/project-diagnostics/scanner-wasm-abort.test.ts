import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	aborted: false,
	abortAfter: Number.POSITIVE_INFINITY,
	parseCalls: 0,
	log: vi.fn(),
}));

vi.mock("../../../clients/tree-sitter-shared.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/tree-sitter-shared.js")
		>();
	const client = {
		isAvailable: () => true,
		init: async () => true,
		runQueriesOnFile: async () => {
			state.parseCalls++;
			if (state.parseCalls === state.abortAfter) state.aborted = true;
			return [];
		},
		withParseCacheMeasurement: async (scan: () => Promise<void>) => scan(),
		// #1715: scanFileMajorRules calls this unconditionally on every real
		// client before parsing starts.
		ensureTreeCacheCapacity: () => {},
	};
	return {
		...actual,
		getSharedTreeSitterClient: () => (state.aborted ? null : client),
		isTreeSitterWasmAborted: () => state.aborted,
	};
});

vi.mock(
	"../../../clients/tree-sitter-query-loader.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../clients/tree-sitter-query-loader.js")
			>();
		return {
			...actual,
			queryLoader: { loadQueries: async () => new Map() },
			queriesForLanguage: () => [{ id: "test", query: "(identifier) @id" }],
		};
	},
);

vi.mock(
	"../../../clients/dispatch/runners/ast-grep-napi.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../clients/dispatch/runners/ast-grep-napi.js")
			>();
		return {
			...actual,
			canHandle: () => false,
			getLang: () => undefined,
			evaluateAstGrepRules: () => [],
			loadSg: async () => null,
		};
	},
);

vi.mock("../../../clients/tree-sitter-logger.js", () => ({
	logTreeSitter: state.log,
	logTreeSitterCacheStats: vi.fn(),
}));

vi.mock("../../../clients/review-graph/builder.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/review-graph/builder.js")
		>();
	return {
		...actual,
		captureReviewGraphStructuralIr: async () => ({
			complete: true,
			structural: {
				kind: "jsts" as const,
				imports: [],
				reexports: [],
				functionSummaries: [],
			},
		}),
	};
});

import { createHash } from "node:crypto";
import {
	loadProjectDiagnosticsSnapshot,
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	saveProjectDiagnosticsSnapshot,
} from "../../../clients/project-diagnostics/cache.js";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import type { ProjectDiagnosticsSnapshot } from "../../../clients/project-diagnostics/types.js";
import {
	clearReviewGraphFileIr,
	getFreshReviewGraphFileIr,
} from "../../../clients/review-graph/shared-extraction-ir.js";
import { removeTempDirSync } from "../test-utils.js";

let tmp: string;

function priorSnapshot(): ProjectDiagnosticsSnapshot {
	return {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd: tmp,
		tier: "cheap",
		scannedAt: "2026-01-01T00:00:00.000Z",
		diagnostics: [
			{
				filePath: path.join(tmp, "old.ts"),
				severity: "warning",
				tool: "tree-sitter",
				runner: "tree-sitter",
				message: "authoritative",
				source: "project-scan",
			},
		],
		filesScanned: 3,
		runners: ["tree-sitter"],
	};
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scan-abort-"));
	for (const name of ["a.ts", "b.ts", "c.ts"]) {
		fs.writeFileSync(path.join(tmp, name), `export const ${name[0]} = 1;\n`);
	}
	state.aborted = false;
	state.abortAfter = Number.POSITIVE_INFINITY;
	state.parseCalls = 0;
	state.log.mockClear();
	clearReviewGraphFileIr(tmp);
});

afterEach(() => {
	removeTempDirSync(tmp);
});

describe("project diagnostics mid-scan WASM abort (#891)", () => {
	it("returns a marked partial scan, logs counts, and preserves the prior authoritative snapshot", async () => {
		const prior = priorSnapshot();
		saveProjectDiagnosticsSnapshot(tmp, prior);
		state.abortAfter = 2;

		const result = await scanProjectDiagnostics({ cwd: tmp, tier: "cheap" });

		expect(result.scanTruncated).toBe(true);
		expect(result.treeSitterStatus).toBe("wasm_aborted_restart_required");
		expect(result.filesScanned).toBe(1);
		expect(state.parseCalls).toBe(2);
		const a = fs.readFileSync(path.join(tmp, "a.ts"), "utf8");
		const b = fs.readFileSync(path.join(tmp, "b.ts"), "utf8");
		expect(
			getFreshReviewGraphFileIr(
				tmp,
				path.join(tmp, "a.ts"),
				createHash("sha256").update(a).digest("hex"),
			),
		).toBeDefined();
		expect(
			getFreshReviewGraphFileIr(
				tmp,
				path.join(tmp, "b.ts"),
				createHash("sha256").update(b).digest("hex"),
			),
		).toBeUndefined();
		expect(loadProjectDiagnosticsSnapshot(tmp)).toEqual(prior);
		expect(state.log).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "wasm_aborted_mid_scan",
				metadata: expect.objectContaining({
					filesScanned: 1,
					totalFiles: 3,
					abortPoint: 2,
				}),
			}),
		);
	});

	it("persists the complete snapshot when no WASM abort occurs", async () => {
		const result = await scanProjectDiagnostics({ cwd: tmp, tier: "cheap" });

		expect(result.scanTruncated).toBeUndefined();
		expect(result.filesScanned).toBe(3);
		expect(loadProjectDiagnosticsSnapshot(tmp)).toEqual(result);
		expect(state.log).not.toHaveBeenCalledWith(
			expect.objectContaining({ reason: "wasm_aborted_mid_scan" }),
		);
	});
});
