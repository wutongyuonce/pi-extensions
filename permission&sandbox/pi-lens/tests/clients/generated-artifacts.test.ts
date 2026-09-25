import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	classifyGeneratedOrArtifactDetailed,
	classifyMachineEmittedLineShape,
	MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
	isDeclarationFile,
	isGeneratedOrArtifact,
} from "../../clients/generated-artifacts.js";

describe("generated-artifacts basename shape-coherence (refs #1161, sibling of #1150/#1152)", () => {
	// Pre-fix, `hasStrongGeneratedArtifactPath`/`hasWeakGeneratedFileNamePattern`
	// used the module-default `path.basename(filePath)`. On Linux CI that is
	// POSIX `basename`, which finds no `/` in a `C:\...` path and returns the
	// whole string unchanged — so `LOCKFILE_NAMES.has(base.toLowerCase())`
	// misses a Windows-shaped lockfile path entirely. This test is meaningful
	// on BOTH OSes per the #1024 discipline: it feeds the literal Windows-shaped
	// string as INPUT (never a normalized/expected key), so on native Windows
	// it exercises the (unchanged, already-correct) win32 `basename` path, and
	// on Linux it exercises the new shape-committed `win32.basename` branch
	// this fix adds. Pre-fix this FAILED on Linux (lockfile under-detected)
	// while the forward-slash-shaped equivalent already passed.
	it("detects a Windows-shaped lockfile path regardless of running OS", () => {
		for (const filePath of [
			"C:\\proj\\package-lock.json",
			"C:\\proj\\yarn.lock",
			"C:\\proj\\pnpm-lock.yaml",
			"\\\\server\\share\\proj\\package-lock.json",
		]) {
			expect(isGeneratedOrArtifact(filePath)).toBe(true);
		}
	});

	it("still detects a POSIX-shaped lockfile path (no regression for the common case)", () => {
		expect(isGeneratedOrArtifact("/home/dev/project/package-lock.json")).toBe(
			true,
		);
	});

	// Same shape-2 defect, this time in `isDeclarationFile` (used by the
	// `includeDeclarations` opt-in in `classifyGeneratedOrArtifactDetailed`).
	it("detects a Windows-shaped .d.ts declaration path regardless of running OS", () => {
		for (const filePath of [
			"C:\\proj\\src\\types.d.ts",
			"C:\\proj\\src\\types.d.mts",
			"C:\\proj\\src\\types.d.cts",
			"\\\\server\\share\\proj\\types.d.ts",
		]) {
			expect(isDeclarationFile(filePath)).toBe(true);
		}
	});

	it("still detects a POSIX-shaped .d.ts declaration path (no regression for the common case)", () => {
		expect(isDeclarationFile("/home/dev/project/src/types.d.ts")).toBe(true);
	});

	it("does not misclassify a hand-written file with 'gen' in a Windows-shaped path (no over-broad match)", () => {
		expect(isGeneratedOrArtifact("C:\\proj\\src\\general.ts")).toBe(false);
	});
});

// #2346: a language-agnostic content-shape test for machine-emitted text — a
// scraped/minified page whose NAME carries no generated marker (`.html`) but
// whose line shape is unambiguously machine-emitted. Threshold derived by
// measurement ON THE SHIPPED PREFIX STATISTIC across all 3,331 repo text
// files on 2026-08-28: worst hand-authored prefix mean 453.2
// (docs/analysisall.md); threshold 2500, ~5.5x margin (see the constant's
// doc comment for the full derivation and the false-KEEP direction rule).
describe("machine-emitted line-shape classification (refs #2346)", () => {
	function minifiedPage(bytes: number, lines: number): string {
		const perLine = Math.floor(bytes / lines);
		const line = `a${'<div class="item">x</div>'.repeat(Math.max(1, Math.floor(perLine / 24)))}`;
		return Array.from({ length: lines }, () => line).join("\n");
	}

	it("classifies a synthetic minified/scraped HTML page as generated (content shape only)", () => {
		const content = minifiedPage(269_000, 38);
		const classification = classifyGeneratedOrArtifactDetailed(
			`/proj/tmp-google-page.html`,
			{ content },
		);
		expect(classification).toMatchObject({
			verdict: "generated",
			evidence: "line-shape",
		});
		expect(classification.lineShapeMean).toBeGreaterThan(
			MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
		);
		expect(
			isGeneratedOrArtifact("/proj/tmp-google-page.html", { content }),
		).toBe(true);
	});

	it("exposes the measured line-shape statistic the record carries", () => {
		const content = `${"x".repeat(3000)}\n${"y".repeat(3000)}\n`;
		expect(classifyMachineEmittedLineShape(content)).toEqual({
			generated: true,
			meanLineLength: 3000,
		});
	});

	it("does not classify a single short line below the minimum content length", () => {
		const content = "a".repeat(500);
		expect(classifyMachineEmittedLineShape(content)).toEqual({
			generated: false,
			meanLineLength: 0,
		});
		expect(isGeneratedOrArtifact("/proj/one-liner.txt", { content })).toBe(
			false,
		);
	});

	it("does not classify empty or whitespace-only content", () => {
		expect(classifyMachineEmittedLineShape("")).toEqual({
			generated: false,
			meanLineLength: 0,
		});
		expect(classifyMachineEmittedLineShape("\n\n\n")).toEqual({
			generated: false,
			meanLineLength: 0,
		});
	});

	it("keeps hand-authored-style content (short lines, any extension) as source", () => {
		const sourceLines = Array.from({ length: 120 }, (_, i) => {
			const body = `const value${i} = computeResult(input, options) + offset;`;
			return `${"".padStart(i % 4, "\t")}${body}`;
		});
		const content = sourceLines.join("\n");
		expect(classifyMachineEmittedLineShape(content).generated).toBe(false);
		expect(isGeneratedOrArtifact("/proj/page.html", { content })).toBe(false);
	});

	it("classifies at exactly the threshold as source, above it as generated (boundary probe)", () => {
		const exact = Array.from({ length: 6 }, () =>
			"x".repeat(MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD),
		).join("\n");
		expect(classifyMachineEmittedLineShape(exact).generated).toBe(false);
		const above = Array.from({ length: 6 }, () =>
			"x".repeat(MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD + 1),
		).join("\n");
		expect(classifyMachineEmittedLineShape(above).generated).toBe(true);
	});

	it("pins the content branch used by createDispatchContext (4096-byte prefix)", () => {
		const prefix = "x".repeat(4096);
		const classification = classifyGeneratedOrArtifactDetailed(
			"/proj/tmp-page.html",
			{ content: prefix },
		);
		expect(classification.verdict).toBe("generated");
		expect(classification.evidence).toBe("line-shape");
	});

	// #2348 review F1: the header-probe branch (analyzeFileHeader → shape) is
	// the one project scans and source walks rest on, and it was previously
	// untested — neutering the shape feed left every suite green. This case
	// hits the REAL disk path: a temp file read through readContentHeader.
	it("classifies a minified file as generated through the on-disk header probe", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-genart-"));
		try {
			const p = path.join(dir, "tmp-minified-page.html");
			fs.writeFileSync(p, `${"z".repeat(30_000)}\n${"w".repeat(30_000)}\n`);
			const classification = classifyGeneratedOrArtifactDetailed(p, {
				readContentHeader: true,
			});
			expect(classification.verdict).toBe("generated");
			expect(classification.evidence).toBe("line-shape");
			expect(classification.lineShapeMean).toBeGreaterThan(
				MACHINE_EMITTED_LINE_SHAPE_MEAN_THRESHOLD,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// #2348 review F2: negative pins on the shipped prefix statistic. The
	// repo's own worst hand-authored file (docs/analysisall.md, prefix mean
	// 453.2 — unwrapped prose paragraphs) and a wide one-line barrel
	// re-export must both stay source.
	it("keeps unwrapped prose paragraphs (analysisall.md shape) as source", () => {
		const paragraph = "word ".repeat(91).trim(); // ~454 chars per line
		const content = Array.from({ length: 9 }, () => paragraph).join("\n\n");
		expect(classifyMachineEmittedLineShape(content).generated).toBe(false);
		expect(isGeneratedOrArtifact("/proj/docs/analysis.md", { content })).toBe(
			false,
		);
	});

	it("keeps a wide single-line barrel re-export as source", () => {
		const names = Array.from({ length: 200 }, (_, i) => `symbol${i}`).join(
			", ",
		);
		const content = `export { ${names} } from "./resources/index.js";\n`;
		expect(content.length).toBeGreaterThan(2048); // passes the min-content gate
		expect(classifyMachineEmittedLineShape(content).generated).toBe(false);
		expect(isGeneratedOrArtifact("/proj/index.d.ts", { content })).toBe(false);
	});
});
