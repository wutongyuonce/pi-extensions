/**
 * #1564 review round 2, finding G4: every test in `grammar-truncation.test.ts`
 * injects a fake manifest via `_setGrammarManifestForTests`, so a stray
 * `TypeError: _setGrammarManifestForTests is not a function` (a missing
 * export, not a missing behavior) was enough to make most of that file's
 * pre-fix run read red — evidence the harness works, not evidence the fix
 * does. This file imports NOTHING test-only: it exercises
 * `downloadGrammarDetailed` exactly as a real caller would, against the
 * REAL committed `scripts/grammars.lock.json`, resolved by the real
 * `getPackageRoot` walk. If it fails, it fails because the sha256 check
 * itself is missing or broken — not because a test seam doesn't exist yet.
 *
 * The fixture is a genuine bundled grammar (`grammars/tree-sitter-json.wasm`,
 * shipped in the npm package) truncated to half its length — the exact #1564
 * shape: the wasm preamble at the front is untouched, so `hasWasmMagic`
 * passes, but the body is short and does not match the pinned hash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { downloadGrammarDetailed } from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

describe("real lock resolution, no manifest injection (#1564 G4)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		env = setupTestEnvironment("pi-lens-grammar-real-lock-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeTempDirSync(env.tmpDir);
	});

	it("rejects a halved real grammar body against the committed lock", async () => {
		const grammarFile = "tree-sitter-json.wasm";
		const realWasmPath = path.resolve(process.cwd(), "grammars", grammarFile);
		const realBytes = fs.readFileSync(realWasmPath);
		// Sanity: this is really the bundled grammar (a few KB), not an empty
		// or stub file — otherwise "halved" wouldn't exercise anything.
		expect(realBytes.length).toBeGreaterThan(1000);
		const halved = realBytes.subarray(0, Math.floor(realBytes.length / 2));

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(halved, { status: 200 }),
		);

		const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.reason).toContain("sha256");
		expect(fs.existsSync(path.join(env.tmpDir, grammarFile))).toBe(false);
	});
});
