/**
 * #3196 round 2, finding L1: the group-emit loop in `formatDeltaMode`
 * (`tools/lens-diagnostics.ts`) pushed a file's `(scanned … ago)` /
 * `(re-verify incomplete)` trailer BEFORE its `projectLines` — so a file with
 * BOTH cache-derived rows (actionable/quality) and a project-diagnostics row
 * rendered the trailer ahead of the project row instead of after every row in
 * the group, misreading as if the label described only the actionable/quality
 * rows above it and left the project row uncovered.
 *
 * Unlike `tests/tools/lens-diagnostics.test.ts` (which mocks
 * `clients/project-diagnostics/cache.js` wholesale, so its project-delta
 * fixtures never touch the real version/freshness validation), THIS file
 * leaves that module real: the delta report is persisted through the real
 * `writeProjectDiagnosticsDeltaReport` and read back through the real
 * `loadProjectDiagnosticsDeltaReport` — `PROJECT_DIAGNOSTICS_CACHE_VERSION`
 * comes from the module, not a hand-copied literal, so a future version bump
 * cannot leave this fixture silently invalid. Only `scanner.js` is mocked
 * (mode=delta never calls it; present only to keep module load side-effect
 * free), matching the pattern `tests/tools/lens-diagnostics-inferred-project.test.ts`
 * uses for the same module.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "../../clients/project-diagnostics/cache.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "../clients/test-utils.js";

vi.mock("../../clients/project-diagnostics/scanner.js", () => ({
	scanProjectDiagnostics: vi.fn(),
}));

function makeCacheManager(data: Record<string, unknown>) {
	return {
		readCache: (key: string) =>
			data[key]
				? { data: data[key], meta: { savedAt: "", scanner: key } }
				: undefined,
	};
}

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-delta-order-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, "data");
	resetProjectLensConfigCache();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmp);
});

describe("mode=delta project-diagnostics row order (#3196 round 2, L1)", () => {
	it("renders a file's project-diagnostics row BEFORE the group's trailer, through a real (validated) delta report", async () => {
		const filePath = path.join(tmp, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const a = 1;\n");
		// Written 5m ago; both caches observed 10m ago -> the actionable row is
		// demoted, so the group gets an age-label trailer to misorder against.
		const editedAtSec = (Date.now() - 5 * 60_000) / 1000;
		fs.utimesSync(filePath, editedAtSec, editedAtSec);
		const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();

		// Real, validated delta report — version from the module, and a
		// generatedAt that postdates the file's last scan-relevant edit so the
		// unmocked freshness gate in `appendProjectDiagnosticsDeltaLines` keeps
		// the row live (not dropped). project-diagnostics freshness is judged
		// on `mtime <= scannedAt` (not the delta-gate's demote semantics), so
		// generatedAt must be AFTER the edit here.
		writeProjectDiagnosticsDeltaReport(tmp, {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd: tmp,
			generatedAt: new Date().toISOString(),
			sessionId: "session-1",
			turnIndex: 1,
			diagnostics: [
				{
					filePath,
					line: 12,
					severity: "error",
					semantic: "blocking",
					tool: "knip",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency lodash",
					source: "project-scan",
				},
			],
			sources: ["knip"],
		});

		const tool = createLensDiagnosticsTool(
			makeCacheManager({
				"actionable-warnings": {
					files: [
						{
							filePath,
							warnings: [
								{
									line: 1,
									rule: "no-unused-vars",
									tool: "eslint",
									message: "a is unused",
								},
							],
						},
					],
					generatedAt: observedAt,
					summary: { warnings: 1 },
				},
			}) as any,
			() => tmp,
		);
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{ cwd: tmp },
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((p) => p.text).join("\n");

		// Premise: the demoted actionable row IS present (so its age-label
		// trailer renders), and the project row IS present too — proving the
		// fixture actually cleared the real version/freshness validation
		// instead of being silently dropped.
		expect(text).toContain("a is unused");
		expect(text).toContain("Unlisted dependency lodash");

		const lines = text.split("\n");
		const projectIdx = lines.findIndex((l) =>
			l.includes("Unlisted dependency lodash"),
		);
		const ageIdx = lines.findIndex((l) => l.trim().startsWith("(scanned"));
		expect(projectIdx, text).toBeGreaterThanOrEqual(0);
		expect(ageIdx, text).toBeGreaterThanOrEqual(0);
		// The project row must render BEFORE the trailer — the trailer follows
		// every content row in the group, never sits ahead of one of them.
		expect(ageIdx, text).toBeGreaterThan(projectIdx);
	});
});
