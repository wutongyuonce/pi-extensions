import { describe, expect, it, vi } from "vitest";

const patternsRef = vi.hoisted(() => ({
	value: ["**/scripts/**", "**/logger.ts"] as readonly string[],
}));

vi.mock(
	"../../../clients/dispatch/ast-grep-catalog.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../clients/dispatch/ast-grep-catalog.js")
		>()),
		buildEffectiveAstGrepCatalog: () => ({
			effectiveRules: new Map([
				["shape-rule", { rule: { ignores: patternsRef.value } }],
			]),
		}),
	}),
);

import { applyAuxiliarySuppressions } from "../../../clients/dispatch/auxiliary-lsp.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";

const finding = (): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "shape test",
		severity: 2,
		source: "ast-grep",
		code: "shape-rule",
	}) as LSPDiagnostic;

const keptWithPatterns = (
	root: string,
	filePath: string,
	patterns: readonly string[] = ["**/scripts/**", "**/logger.ts"],
): boolean => {
	// The mocked catalog still exercises the consumer's complete suppression path.
	patternsRef.value = patterns;
	return (
		applyAuxiliarySuppressions([finding()], "content", {
			scanRoot: root,
			filePath,
		}).length === 1
	);
};

const kept = (root: string, filePath: string): boolean =>
	keptWithPatterns(root, filePath);

describe("rule-ignore matcher path-shape containment (#3240 r3)", () => {
	it("keeps directory carve-outs inside the root but outside its boundary", () => {
		// Prevents #3240 r3: startsWith("..") treated an in-root `..evil` segment
		// and prefix siblings as out-of-root, while host path.relative lost Windows
		// drive-shaped containment on Linux.
		const cases: Array<[string, string, boolean]> = [
			["/tmp/root", "/tmp/root/scripts/x.ts", false],
			["/tmp/root", "/tmp/root/..evil/scripts/x.ts", false],
			["/tmp/root", "/tmp/root2/scripts/x.ts", true],
			["/tmp/root", "/tmp/other/scripts/x.ts", true],
			["C:\\repo", "C:\\repo\\packages\\scripts\\x.ts", false],
			["C:\\repo", "C:\\repo\\..evil\\scripts\\x.ts", false],
			["C:\\repo", "C:\\repo2\\scripts\\x.ts", true],
			["C:\\repo", "D:\\repo\\scripts\\x.ts", true],
			[
				"\\\\server\\share\\repo",
				"\\\\server\\share\\repo\\scripts\\x.ts",
				false,
			],
			[
				"\\\\server\\share\\repo",
				"\\\\server\\share\\repo2\\scripts\\x.ts",
				true,
			],
			[
				"\\\\server\\share\\repo",
				"\\\\other\\share\\repo\\scripts\\x.ts",
				true,
			],
			["/tmp/root", "/tmp/root/file.ts", true],
			["/tmp/root", "C:\\repo\\scripts\\x.ts", true],
			["C:\\repo", "/tmp/root/scripts/x.ts", true],
		];
		for (const [root, filePath, shouldKeep] of cases) {
			expect(kept(root, filePath), `${root} -> ${filePath}`).toBe(shouldKeep);
		}
	});

	it("recognizes root identity with the same shape-aware containment path", () => {
		// Root identity is the empty relative path, which is inside rather than an
		// out-of-root fallback; this prevents shape branches from losing the root.
		expect(keptWithPatterns("/tmp/root", "/tmp/root", ["**"])).toBe(false);
		expect(keptWithPatterns("C:\\repo", "C:\\repo", ["**"])).toBe(false);
	});

	it("keeps the documented absolute fallback for an out-of-root logger leaf", () => {
		expect(kept("C:\\repo", "D:\\elsewhere\\logger.ts")).toBe(false);
		expect(kept("\\\\server\\share\\repo", "\\\\other\\share\\logger.ts")).toBe(
			false,
		);
	});

	it("matches leaf globs after the same shape-aware containment decision", () => {
		const cases: Array<[string, string, boolean]> = [
			["/tmp/root", "/tmp/root/logger.ts", false],
			["/tmp/root", "/tmp/root2/logger.ts", false],
			["C:\\repo", "C:\\repo\\packages\\logger.ts", false],
			["C:\\repo", "D:\\repo\\logger.ts", false],
			["\\\\server\\share\\repo", "\\\\server\\share\\repo\\logger.ts", false],
		];
		for (const [root, filePath, shouldKeep] of cases) {
			expect(
				keptWithPatterns(root, filePath, ["**/logger.ts"]),
				`${root} -> ${filePath}`,
			).toBe(shouldKeep);
		}
	});
});
