import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProjectDiagnosticsDeltaReport,
	loadProjectDiagnosticsSnapshot,
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	reconcileProjectDiagnosticsSnapshot,
	saveProjectDiagnosticsSnapshot,
	writeProjectDiagnosticsDeltaReport,
} from "../../clients/project-diagnostics/cache.js";
import { MTIME_DRIFT_TOLERANCE_MS } from "../../clients/blocker-freshness.js";
import { knipIssuesToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/knip.js";
import { jscpdResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/jscpd.js";
import { circularDepsToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/madge.js";
import { gitleaksResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/gitleaks.js";
import { govulncheckResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/govulncheck.js";
import { trivyResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/trivy.js";
import { opengrepResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/opengrep.js";
import { deadCodeResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/dead-code.js";
import { callGraphImpactToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/call-graph-impact.js";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import type {
	ProjectDiagnosticsDeltaReport,
	ProjectDiagnosticsSnapshot,
} from "../../clients/project-diagnostics/types.js";
import { removeTempDirSync } from "./test-utils.js";

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-diags-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmp);
});

function snapshot(
	overrides: Partial<ProjectDiagnosticsSnapshot> = {},
): ProjectDiagnosticsSnapshot {
	return {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd: tmp,
		tier: "cheap",
		scannedAt: "2026-01-01T00:00:00.000Z",
		diagnostics: [],
		filesScanned: 0,
		runners: ["fact-rules"],
		...overrides,
	};
}

function deltaReport(
	overrides: Partial<ProjectDiagnosticsDeltaReport> = {},
): ProjectDiagnosticsDeltaReport {
	return {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd: tmp,
		generatedAt: "2026-01-01T00:00:00.000Z",
		sessionId: "session-1",
		turnIndex: 1,
		diagnostics: [],
		sources: [],
		...overrides,
	};
}

describe("project diagnostics cache", () => {
	it("persists snapshots under the project data dir", () => {
		const saved = snapshot({
			diagnostics: [
				{
					filePath: path.join(tmp, "src/a.ts"),
					line: 1,
					severity: "warning",
					semantic: "warning",
					tool: "fact-rules",
					runner: "fact-rules",
					rule: "pass-through-wrappers",
					message: "wrapper",
					source: "project-scan",
				},
			],
		});
		saveProjectDiagnosticsSnapshot(tmp, saved);
		expect(loadProjectDiagnosticsSnapshot(tmp)).toEqual(saved);
	});

	it("ignores stale cache versions", () => {
		// Deliberately pinned to the literal 0, below PROJECT_DIAGNOSTICS_CACHE_VERSION,
		// to exercise the stale-version rejection path itself (the #1082/#1106
		// vacuous-fixture class: a future bump to 0 would silently un-exercise this).
		expect(PROJECT_DIAGNOSTICS_CACHE_VERSION).not.toBe(0);
		saveProjectDiagnosticsSnapshot(tmp, snapshot({ version: 0 }));
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

	it("persists delta reports", () => {
		const report = {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd: tmp,
			generatedAt: "2026-01-01T00:00:00.000Z",
			sessionId: "session-1",
			turnIndex: 2,
			diagnostics: [
				{
					filePath: path.join(tmp, "src/a.ts"),
					line: 3,
					severity: "error" as const,
					semantic: "blocking" as const,
					tool: "knip",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency react",
					source: "project-scan" as const,
				},
			],
			sources: ["knip"],
		};
		writeProjectDiagnosticsDeltaReport(tmp, report);
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toEqual(report);
	});

	it("returns undefined when no delta report has been written", () => {
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toBeUndefined();
	});

	it("ignores stale delta report versions", () => {
		// Deliberately pinned to the literal 0, below PROJECT_DIAGNOSTICS_CACHE_VERSION,
		// to exercise the stale-version rejection path itself (the #1082/#1106
		// vacuous-fixture class: a future bump to 0 would silently un-exercise this).
		expect(PROJECT_DIAGNOSTICS_CACHE_VERSION).not.toBe(0);
		writeProjectDiagnosticsDeltaReport(tmp, deltaReport({ version: 0 }));
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toBeUndefined();
	});
});

function setMtime(file: string, ms: number): void {
	const when = new Date(ms);
	fs.utimesSync(file, when, when);
}

describe("reconcileProjectDiagnosticsSnapshot (#298 staleness)", () => {
	function diag(filePath: string) {
		return {
			filePath,
			line: 1,
			severity: "error" as const,
			semantic: "blocking" as const,
			tool: "typescript",
			runner: "lsp",
			code: "2307",
			message: "Cannot find module './reader.ts'",
			source: "project-scan" as const,
		};
	}

	it("drops a diagnostic for a file edited after the scan", () => {
		const f = path.join(tmp, "reader.ts");
		fs.writeFileSync(f, "export const countTotal = 1;\n");
		const snap = snapshot({
			scannedAt: "2026-01-01T00:00:00.000Z",
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		// Edit the file now (mtime >> scannedAt) — the recorded error is stale.
		fs.writeFileSync(f, "export const countTotal = 2;\nexport const x = 3;\n");
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(0);
		expect(staleDropped).toBe(1);
	});

	it("drops a diagnostic for a deleted file", () => {
		const f = path.join(tmp, "gone.ts");
		const snap = snapshot({
			scannedAt: new Date().toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		// File never existed on disk (or was deleted after the scan).
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(0);
		expect(staleDropped).toBe(1);
	});

	it("keeps a diagnostic for an unchanged file (and returns the same object)", () => {
		const f = path.join(tmp, "stable.ts");
		fs.writeFileSync(f, "export const a = 1;\n");
		// Scan AFTER writing the file, so mtime <= scannedAt → not stale.
		const snap = snapshot({
			scannedAt: new Date(Date.now() + 1000).toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(1);
		expect(staleDropped).toBe(0);
		expect(reconciled).toBe(snap); // no-op returns the original reference
	});

	it("is fail-safe on an unparseable scannedAt (keeps everything)", () => {
		const f = path.join(tmp, "missing.ts");
		const snap = snapshot({
			scannedAt: "not-a-date",
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(1);
		expect(staleDropped).toBe(0);
	});

	// #1711: fabricates the mtime/scannedAt pair directly, rather than relying
	// on a real write race, so the boundary is deterministic. A bare +1ms
	// tolerance did not cover the measured Windows host skew between a file's
	// mtime and the `Date.now()` read that produces `scannedAt` (up to
	// ~11.4ms, #1491/#1498) — a same-tick write-then-scan silently DROPPED a
	// live diagnostic here, the worse sibling of #1708's demote-only gate.
	it("keeps a diagnostic whose mtime lands within MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const f = path.join(tmp, "same-tick.ts");
		fs.writeFileSync(f, "export const a = 1;\n");
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		setMtime(f, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS);
		const snap = snapshot({
			scannedAt: new Date(scannedAtMs).toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(1);
		expect(staleDropped).toBe(0);
	});

	// Pins the far edge so a deleted or widened tolerance cannot survive:
	// one millisecond past MTIME_DRIFT_TOLERANCE_MS still drops.
	it("still drops a diagnostic whose mtime lands past MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const f = path.join(tmp, "genuine-edit.ts");
		fs.writeFileSync(f, "export const a = 1;\n");
		const scannedAtMs = Date.UTC(2026, 7, 18, 7, 0, 0);
		setMtime(f, scannedAtMs + MTIME_DRIFT_TOLERANCE_MS + 1);
		const snap = snapshot({
			scannedAt: new Date(scannedAtMs).toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(0);
		expect(staleDropped).toBe(1);
	});
});

describe("project diagnostics adapters", () => {
	it("normalizes Knip issues into ProjectDiagnostic records", () => {
		const [unlisted, unusedExport] = knipIssuesToProjectDiagnostics(tmp, [
			{ type: "unlisted", name: "left-pad", file: "src/a.ts", line: 4 },
			{ type: "export", name: "unused", file: "src/b.ts", line: 8 },
		]);

		expect(unlisted).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			severity: "error",
			semantic: "blocking",
			runner: "knip",
			rule: "knip:unlisted",
			message: "Unlisted dependency left-pad",
		});
		expect(unusedExport).toMatchObject({
			filePath: path.join(tmp, "src/b.ts"),
			severity: "warning",
			semantic: "warning",
			rule: "knip:export",
			message: "Unused export unused",
		});
	});

	it("maps a jscpd clone to a diagnostic on BOTH ends, each naming the other", () => {
		const diags = jscpdResultToProjectDiagnostics(tmp, {
			success: true,
			duplicatedLines: 18,
			totalLines: 100,
			percentage: 18,
			clones: [
				{
					fileA: "src/a.ts",
					startA: 42,
					fileB: "src/b.ts",
					startB: 80,
					lines: 18,
					tokens: 120,
				},
			],
		});

		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			line: 42,
			severity: "warning",
			runner: "jscpd",
			rule: "jscpd:duplicate",
			message: `Duplicate code (18 lines) — also at ${path.join("src", "b.ts")}:80`,
		});
		expect(diags[1]).toMatchObject({
			filePath: path.join(tmp, "src/b.ts"),
			line: 80,
			message: `Duplicate code (18 lines) — also at ${path.join("src", "a.ts")}:42`,
		});
	});

	it("returns no jscpd diagnostics on a failed or empty scan", () => {
		expect(
			jscpdResultToProjectDiagnostics(tmp, {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			}),
		).toEqual([]);
		expect(
			jscpdResultToProjectDiagnostics(tmp, {
				success: true,
				clones: [],
				duplicatedLines: 0,
				totalLines: 10,
				percentage: 0,
			}),
		).toEqual([]);
	});

	it("maps a madge cycle to a diagnostic on EACH participating file", () => {
		const diags = circularDepsToProjectDiagnostics(tmp, [
			{ file: "src/a.ts", path: ["src/a.ts", "src/b.ts", "src/c.ts"] },
		]);

		expect(diags.map((d) => d.filePath)).toEqual([
			path.join(tmp, "src/a.ts"),
			path.join(tmp, "src/b.ts"),
			path.join(tmp, "src/c.ts"),
		]);
		for (const d of diags) {
			expect(d).toMatchObject({
				runner: "madge",
				rule: "madge:circular",
				severity: "warning",
				message: "Part of circular dependency: a.ts → b.ts → c.ts → a.ts",
			});
		}
	});

	it("dedupes a madge cycle reported from multiple anchors", () => {
		const diags = circularDepsToProjectDiagnostics(tmp, [
			{ file: "src/a.ts", path: ["src/a.ts", "src/b.ts"] },
			{ file: "src/b.ts", path: ["src/b.ts", "src/a.ts"] }, // same cycle, other anchor
		]);
		// Same member set → emitted once (one diagnostic per file, not per anchor).
		expect(diags).toHaveLength(2);
	});

	it("maps call-graph impact findings to non-blocking diagnostics on the CALLER's file, with no line", () => {
		const diags = callGraphImpactToProjectDiagnostics(tmp, [
			{
				calleeKey: "src/b.ts:changedFn",
				results: [
					{
						symbolKey: "src/a.ts:directCaller",
						depth: 1,
						severity: "WillBreak",
					},
					{
						symbolKey: "src/c.ts:indirectCaller",
						depth: 2,
						severity: "MayBreak",
					},
					{ symbolKey: "src/d.ts:farCaller", depth: 3, severity: "Review" },
				],
			},
		]);

		// Review tier is dropped — too diluted at that BFS depth to attribute
		// to a specific caller (mirrors formatImpact's own count-only treatment).
		expect(diags).toHaveLength(2);

		const willBreak = diags.find((d) => d.rule === "call-graph:willbreak");
		expect(willBreak).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			severity: "warning",
			semantic: "warning",
			tool: "call-graph",
			runner: "call-graph",
			source: "project-scan",
		});
		expect(willBreak?.line).toBeUndefined();
		expect(willBreak?.message).toContain("directCaller");
		expect(willBreak?.message).toContain("changedFn");

		const mayBreak = diags.find((d) => d.rule === "call-graph:maybreak");
		expect(mayBreak).toMatchObject({
			filePath: path.join(tmp, "src/c.ts"),
			severity: "info",
			semantic: "warning",
		});
		expect(mayBreak?.line).toBeUndefined();

		// Never escalates to this codebase's hard-stop tier (#533 honesty) —
		// impact() has no type info, so a resolved caller is never a CONFIRMED
		// break.
		expect(diags.every((d) => d.semantic !== "blocking")).toBe(true);
	});

	it("dedupes the same caller reached via multiple edited symbols, keeping the higher severity", () => {
		const diags = callGraphImpactToProjectDiagnostics(tmp, [
			{
				calleeKey: "src/b.ts:changedFnOne",
				results: [
					{
						symbolKey: "src/a.ts:sharedCaller",
						depth: 2,
						severity: "MayBreak",
					},
				],
			},
			{
				calleeKey: "src/b.ts:changedFnTwo",
				results: [
					{
						symbolKey: "src/a.ts:sharedCaller",
						depth: 1,
						severity: "WillBreak",
					},
				],
			},
		]);

		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			severity: "warning", // WillBreak wins over the earlier MayBreak hit
			rule: "call-graph:willbreak",
		});
	});

	it("maps gitleaks secrets to BLOCKING diagnostics", () => {
		const [diag] = gitleaksResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "2026-01-01T00:00:00.000Z",
			findings: [
				{
					ruleId: "aws-access-key",
					description: "AWS Access Key",
					file: "src/config.ts",
					startLine: 12,
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "src/config.ts"),
			line: 12,
			severity: "error",
			semantic: "blocking",
			runner: "gitleaks",
			rule: "gitleaks:aws-access-key",
			message: "Potential secret: AWS Access Key",
		});
	});

	it("maps an opengrep ERROR finding to a BLOCKING diagnostic, with CWE in the message", () => {
		const [diag] = opengrepResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "2026-01-01T00:00:00.000Z",
			findings: [
				{
					checkId: "python.lang.security.audit.subprocess-shell-true",
					path: "src/run.py",
					startLine: 7,
					startCol: 3,
					endLine: 7,
					endCol: 20,
					message: "shell=True is dangerous",
					severity: "ERROR",
					cwe: ["CWE-78: OS Command Injection"],
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "src/run.py"),
			line: 7,
			column: 3,
			severity: "error",
			semantic: "blocking",
			runner: "opengrep",
			rule: "opengrep:python.lang.security.audit.subprocess-shell-true",
			message: "shell=True is dangerous (CWE-78: OS Command Injection)",
		});
	});

	it("maps an opengrep WARNING/INFO finding to a non-blocking diagnostic", () => {
		const diags = opengrepResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			findings: [
				{
					checkId: "generic.warning-rule",
					path: "src/a.ts",
					startLine: 1,
					startCol: 1,
					endLine: 1,
					endCol: 1,
					message: "warn finding",
					severity: "WARNING",
				},
				{
					checkId: "generic.info-rule",
					path: "src/b.ts",
					startLine: 1,
					startCol: 1,
					endLine: 1,
					endCol: 1,
					message: "info finding",
					severity: "INFO",
				},
			],
		});
		expect(diags[0]).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(diags[1]).toMatchObject({ severity: "info", semantic: "warning" });
	});

	it("returns no opengrep diagnostics on a failed or empty scan", () => {
		expect(
			opengrepResultToProjectDiagnostics(tmp, {
				success: false,
				findings: [],
				scannedAt: "",
			}),
		).toEqual([]);
		expect(
			opengrepResultToProjectDiagnostics(tmp, {
				success: true,
				findings: [],
				scannedAt: "",
			}),
		).toEqual([]);
	});

	it("anchors a govulncheck finding at the first traced source frame", () => {
		const [diag] = govulncheckResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			findings: [
				{
					osv: "GO-2024-1",
					packageName: "golang.org/x/net",
					fixedVersion: "0.23.0",
					summary: "HTTP/2 flood",
					trace: [
						{ filename: "internal/server.go", line: 88 },
						{ filename: "vendor/x/net/http2.go", line: 10 },
					],
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "internal/server.go"),
			line: 88,
			severity: "warning",
			runner: "govulncheck",
			rule: "govulncheck:GO-2024-1",
			message: "Vulnerability GO-2024-1: HTTP/2 flood (fixed in 0.23.0)",
		});
	});

	it("anchors a trivy CVE at its manifest target (no line)", () => {
		const [diag] = trivyResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			secrets: [],
			licenses: [],
			findings: [
				{
					vulnerabilityId: "CVE-2024-9",
					pkgName: "lodash",
					installedVersion: "4.17.20",
					fixedVersion: "4.17.21",
					severity: "HIGH",
					target: "package-lock.json",
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "package-lock.json"),
			severity: "warning",
			runner: "trivy",
			rule: "trivy:CVE-2024-9",
			message:
				"HIGH vulnerability CVE-2024-9 in lodash@4.17.20 (fixed in 4.17.21)",
		});
		expect(diag.line).toBeUndefined();
	});

	// #1628: trivy's `secrets` findings (`TrivyResult.secrets`) had no adapter
	// at all before this — the CVE lane (`findings`) was the only trivy lane
	// `lens_diagnostics mode=full` surfaced. A trivy-only secret (no gitleaks/
	// ast-grep corroboration) was invisible there, so an agent had nothing to
	// anchor a `lens_diagnostic_mark` call against.
	it("anchors a trivy secret at its file:line, namespaced apart from the CVE rule id", () => {
		const [diag] = trivyResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			findings: [],
			licenses: [],
			secrets: [
				{
					ruleId: "aws-access-key-id",
					file: ".env",
					line: 3,
					title: "AWS Access Key ID",
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, ".env"),
			line: 3,
			severity: "error",
			semantic: "blocking",
			tool: "trivy",
			runner: "trivy",
			rule: "trivy-secret:aws-access-key-id",
			message: "Potential secret: AWS Access Key ID",
		});
	});

	it("surfaces both a CVE and a secret from the same trivy scan pass", () => {
		const diags = trivyResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			licenses: [],
			findings: [
				{
					vulnerabilityId: "CVE-2024-9",
					pkgName: "lodash",
					severity: "HIGH",
					target: "package-lock.json",
				},
			],
			secrets: [{ ruleId: "generic-api-key", file: "a.ts", line: 5 }],
		});
		expect(diags).toHaveLength(2);
		expect(diags.map((d) => d.rule)).toEqual([
			"trivy:CVE-2024-9",
			"trivy-secret:generic-api-key",
		]);
	});

	it("flattens dead-code buckets; unlisted deps are blocking", () => {
		const diags = deadCodeResultToProjectDiagnostics(tmp, {
			success: true,
			language: "python",
			summary: "",
			unusedExports: [
				{
					category: "export",
					kind: "function",
					name: "foo",
					file: "a.py",
					line: 4,
				},
			],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [
				{
					category: "unlisted",
					kind: "import",
					name: "requests",
					file: "b.py",
					line: 1,
				},
			],
		});
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: path.join(tmp, "a.py"),
			line: 4,
			semantic: "warning",
			runner: "dead-code-python",
			rule: "dead-code:export",
			message: "Unused function foo",
		});
		expect(diags[1]).toMatchObject({
			semantic: "blocking",
			rule: "dead-code:unlisted",
			message: "Unlisted dependency requests",
		});
	});
});

describe("scanProjectDiagnostics", () => {
	it("caps source collection before scanning", async () => {
		const srcDir = path.join(tmp, "src-cap");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(path.join(srcDir, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(srcDir, "b.ts"), "export const b = 1;\n");
		fs.writeFileSync(path.join(srcDir, "c.ts"), "export const c = 1;\n");

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 2,
		});

		expect(result.filesScanned).toBe(2);
	});

	it("returns a partial snapshot without persisting it when aborted (#341)", async () => {
		const srcDir = path.join(tmp, "src-abort");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(srcDir, "ui.ts"),
			'export function notify() { alert("hi"); }\n',
		);

		const controller = new AbortController();
		controller.abort();
		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
			signal: controller.signal,
		});

		// All phases were skipped (no runners ran) and the partial snapshot was
		// NOT written to the cross-session cache.
		expect(result.runners).toEqual([]);
		expect(result.diagnostics).toEqual([]);
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

	it("runs cheap project scanners and writes a normalized snapshot", async () => {
		const srcDir = path.join(tmp, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(srcDir, "wrap.ts"),
			[
				"function inner(value: number) { return value; }",
				"function wrap(value: number) {",
				"  return inner(value);",
				"}",
			].join("\n"),
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
		});

		expect(result.tier).toBe("cheap");
		expect(result.filesScanned).toBe(1);
		expect(result.runners).toContain("fact-rules");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: path.join(srcDir, "wrap.ts"),
					runner: "fact-rules",
					rule: "pass-through-wrappers",
					source: "project-scan",
				}),
			]),
		);
		expect(loadProjectDiagnosticsSnapshot(tmp)?.diagnostics.length).toBe(
			result.diagnostics.length,
		);
	});

	it("runs ast-grep-napi project-wide without the ast-grep binary (#308)", async () => {
		const srcDir = path.join(tmp, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// `alert($$$ARGS)` is the shipped `no-alert` rule — a clean, suppression-free
		// match that exercises the bundled napi engine (no binary involved).
		fs.writeFileSync(
			path.join(srcDir, "ui.ts"),
			'export function notify() { alert("hi"); }\n',
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
		});

		expect(result.runners).toContain("ast-grep-napi");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: path.join(srcDir, "ui.ts"),
					runner: "ast-grep-napi",
					tool: "ast-grep-napi",
					rule: "no-alert",
					source: "project-scan",
				}),
			]),
		);
	});

	it("preserves phase-major diagnostic ordering in the merged file pass (#896)", async () => {
		const srcDir = path.join(tmp, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		const filePath = path.join(srcDir, "combined.ts");
		fs.writeFileSync(
			filePath,
			[
				"function inner(value: number) { return value; }",
				"function wrapper(value: number) {",
				"  return inner(value);",
				"}",
				'function notify() { alert("hi"); }',
			].join("\n"),
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
		});

		const factIndex = result.diagnostics.findIndex(
			(d) => d.filePath === filePath && d.runner === "fact-rules",
		);
		const astGrepIndex = result.diagnostics.findIndex(
			(d) =>
				d.filePath === filePath &&
				d.runner === "ast-grep-napi" &&
				d.rule === "no-alert",
		);
		expect(factIndex).toBeGreaterThanOrEqual(0);
		expect(astGrepIndex).toBeGreaterThan(factIndex);
		expect(result.runners).toEqual([
			"tree-sitter",
			"fact-rules",
			"ast-grep-napi",
		]);
	});

	it("excludes ignored/excluded files from the ast-grep scan (#308)", async () => {
		// node_modules is a canonical excluded dir — its violations must not surface.
		const vendored = path.join(tmp, "node_modules", "pkg");
		fs.mkdirSync(vendored, { recursive: true });
		fs.writeFileSync(
			path.join(vendored, "index.ts"),
			'export function n() { alert("vendored"); }\n',
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 50,
		});

		expect(
			result.diagnostics.filter((d) => d.filePath.includes("node_modules")),
		).toHaveLength(0);
	});
});
