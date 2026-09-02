import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FINDING_ID_HASH_LENGTH,
	hashText,
	normalizeMessage,
	relativeFile,
	stableFindingId,
} from "../../clients/finding-identity.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

describe("finding-identity", () => {
	it("hashes to the shared 12-char length", () => {
		expect(FINDING_ID_HASH_LENGTH).toBe(12);
		expect(hashText("anything")).toHaveLength(12);
	});

	it("normalizes whitespace and case in messages", () => {
		expect(normalizeMessage("  Remove   console.log  ")).toBe(
			"remove console.log",
		);
	});

	it("stableFindingId hashes relativeFile + parts under the caller's prefix", () => {
		const cwd = path.join(os.tmpdir(), "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const id = stableFindingId("zz:", {
			cwd,
			filePath,
			parts: ["tool", "rule", "msg", 3],
		});
		expect(id).toMatch(/^zz:[0-9a-f]{12}$/);
	});

	it("stableFindingId folds an undefined part the same as an explicit empty string", () => {
		const cwd = path.join(os.tmpdir(), "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const withUndefined = stableFindingId("zz:", {
			cwd,
			filePath,
			parts: ["tool", undefined, "msg"],
		});
		const withEmpty = stableFindingId("zz:", {
			cwd,
			filePath,
			parts: ["tool", "", "msg"],
		});
		expect(withUndefined).toBe(withEmpty);
	});

	// Review-round F4 (#1816): a runtime `null` (a JSON.parse'd tool field
	// assigned straight into a `T | undefined`-typed diagnostic field, which
	// defeats the static type) must fold the same as `undefined` and an
	// explicit `""` — not stringify to the literal "null", which would
	// diverge from every other id-construction path for the same finding.
	it("stableFindingId folds a runtime null part the same as undefined and an explicit empty string", () => {
		const cwd = path.join(os.tmpdir(), "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const withNull = stableFindingId("zz:", {
			cwd,
			filePath,
			parts: ["tool", null, "msg"],
		});
		const withEmpty = stableFindingId("zz:", {
			cwd,
			filePath,
			parts: ["tool", "", "msg"],
		});
		expect(withNull).toBe(withEmpty);
	});

	// #533 class (mirrors diagnostic-dispositions.test.ts's "anchor path-form
	// stability" fixture): relativeFile canonicalizes BOTH cwd and filePath
	// through normalizeMapKey before relativizing, so a raw mis-cased path form
	// and its normalizeMapKey'd form of the SAME on-disk file must derive the
	// identical relative path. This is the exact guard #1816 item 2 sweeps into
	// actionable-warnings.ts and code-quality-warnings.ts, which previously
	// hashed the raw form. Mutation-proof: dropping the normalizeMapKey calls
	// inside relativeFile (i.e. reverting to bare path.relative(cwd, filePath))
	// makes this fail on a case-insensitive filesystem, since `SUB/a.ts` and
	// `sub/a.ts` would then relativize to different strings.
	it("relativeFile canonicalizes a raw mis-cased path form to the same relative path as its normalized form", (ctx) => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-finding-identity-"),
		);
		try {
			const subDirOnDisk = path.join(projectDir, "sub");
			fs.mkdirSync(subDirOnDisk, { recursive: true });
			const fileOnDisk = path.join(subDirOnDisk, "a.ts");
			fs.writeFileSync(fileOnDisk, "const x = 1;\n");

			// WRITE form: a mis-cased segment, as a raw path.resolve(cwd, arg) that
			// never went through realpath canonicalization would carry.
			const rawFile = path.join(projectDir, "SUB", "a.ts");
			// This mis-cased scenario only aliases on a CASE-INSENSITIVE filesystem
			// (Windows/macOS default). On a case-sensitive FS (Linux CI), `SUB` and
			// `sub` are genuinely different paths — skip VISIBLY rather than
			// returning, which reports a pass (#2089).
			ctx.skip(
				!fs.existsSync(rawFile),
				"case-sensitive filesystem: SUB/a.ts does not alias sub/a.ts",
			);

			const normalizedCwd = normalizeMapKey(projectDir);
			const normalizedFile = normalizeMapKey(fileOnDisk);

			const rawRelative = relativeFile(rawFile, projectDir);
			const normalizedRelative = relativeFile(normalizedFile, normalizedCwd);

			expect(rawRelative).toBe(normalizedRelative);
		} finally {
			removeTempDirSync(projectDir);
		}
	});
});
