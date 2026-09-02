import { describe, expect, it } from "vitest";
import {
	KIND_EXTENSIONS,
	isJstsFactFile,
	isReadableSourceFile,
} from "../../clients/file-kinds.js";
import { functionFactProvider } from "../../clients/dispatch/facts/function-facts.js";
import { importFactProvider } from "../../clients/dispatch/facts/import-facts.js";

const contextFor = (filePath: string) => ({ filePath }) as never;

describe("extension predicate coverage", () => {
	it("keeps both JS/TS fact providers bound to the canonical jsts extensions", () => {
		for (const extension of KIND_EXTENSIONS.jsts) {
			const appliesToFacts = isJstsFactFile(`fixture${extension}`);
			expect(
				functionFactProvider.appliesTo(contextFor(`fixture${extension}`)),
			).toBe(appliesToFacts);
			expect(
				importFactProvider.appliesTo(contextFor(`fixture${extension}`)),
			).toBe(appliesToFacts);
		}

		// The pre-#1388 regex `\.(?:c|m)?(?:js|jsx|ts|tsx)$` also matched these
		// four compound suffixes. None exists in any toolchain (TypeScript ships
		// .mts/.cts but no JSX variants of them), so their removal is deliberate,
		// not a regression — this pins that decision.
		expect(isJstsFactFile("fixture.cjsx")).toBe(false);
		expect(isJstsFactFile("fixture.mjsx")).toBe(false);
		expect(isJstsFactFile("fixture.ctsx")).toBe(false);
		expect(isJstsFactFile("fixture.mtsx")).toBe(false);
	});

	it("accepts every canonical kind extension for bash file access", () => {
		for (const extensions of Object.values(KIND_EXTENSIONS)) {
			for (const extension of extensions) {
				expect(isReadableSourceFile(`fixture${extension}`)).toBe(true);
			}
		}
	});

	it("preserves the explicit non-kind text/config allowlist", () => {
		for (const extension of [".txt", ".env", ".cfg", ".conf", ".ini", ".xml"]) {
			expect(isReadableSourceFile(`fixture${extension}`)).toBe(true);
		}
	});
});
