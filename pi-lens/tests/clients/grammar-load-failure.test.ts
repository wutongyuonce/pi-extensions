/**
 * Regression tests for #1564's third part: a `Language.load` failure on a
 * file `resolveGrammarFile` just vouched for must record a degradation and
 * invalidate the resolve memo, not silently return `null`.
 *
 * A truncated-but-magic-valid grammar file (the #1564 shape) passes the
 * `\0asm` preamble check, so `resolveGrammarFile` hands it to `Language.load`
 * as trustworthy. `Language.load` then fails with a decode error such as
 * "Code section extends past end of the module" — NOT abort-shaped, so
 * pre-fix `reportWasmAbort` ignored it and the catch block only `dbg`'d and
 * returned `null`. Nothing was recorded, the resolve memo kept vouching for
 * the same broken file, and no re-download was ever attempted: the language
 * degraded silently for the rest of the process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _setGrammarManifestForTests } from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

/** A genuinely valid wasm preamble — passes `hasWasmMagic`/`fileHasWasmMagic`
 * while being nowhere near a real grammar's byte count, standing in for a
 * connection that dropped right after the header. */
const TRUNCATED_WASM = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
const OTHER_VALID_WASM = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad,
]);

type LoadLanguageClient = {
	loadLanguage(languageId: string): Promise<unknown>;
	resolveGrammarFile(file: string): string | undefined;
	grammarSourceDirs(): string[];
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
	ParserClass: unknown;
	LanguageLoader: { load: (path: string) => Promise<unknown> };
};

async function makeClient(dir: string): Promise<LoadLanguageClient> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	const client = new TreeSitterClient() as unknown as LoadLanguageClient;
	client.grammarsDir = dir;
	vi.spyOn(client, "grammarSourceDirs").mockReturnValue([dir]);
	vi.spyOn(client, "grammarsWriteDir").mockReturnValue(dir);
	client.ParserClass = {};
	return client;
}

describe("Language.load failure on a vouched-for file (#1564)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		// These fixtures write ARBITRARY bytes under a real grammar filename
		// (loadLanguage needs an entry LANGUAGE_TO_GRAMMAR actually maps to) —
		// nothing here is testing the #1760 pinned-hash staleness check, so an
		// empty manifest keeps `pinnedGrammarHash` answering "can't verify,
		// trust it" instead of the fixture bytes tripping a mismatch against
		// the REAL committed grammars.lock.json entry for tree-sitter-python.wasm.
		_setGrammarManifestForTests({
			package: "tree-sitter-wasms",
			version: "0.0.0-test",
			grammars: {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_setGrammarManifestForTests(undefined);
		removeTempDirSync(env.tmpDir);
	});

	it("records a degradation naming the grammar and the loader's error", async () => {
		env = setupTestEnvironment("pi-lens-grammar-load-fail-");
		const grammarFile = "tree-sitter-python.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, TRUNCATED_WASM);

		const client = await makeClient(env.tmpDir);
		const decodeError = new Error(
			"Code section extends past end of the module",
		);
		client.LanguageLoader = { load: vi.fn().mockRejectedValue(decodeError) };

		const result = await client.loadLanguage("python");

		expect(result).toBeNull();
		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		const entry = group?.latestReasons.find((r) => r.subject === grammarFile);
		expect(entry?.reason).toContain("Language.load failed");
		expect(entry?.reason).toContain("Code section extends past end");
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(notifyUserDegradation.mock.calls[0][0]).toContain(
			"Code section extends past end",
		);
	});

	it("invalidates the resolve memo so a later demand can re-fetch", async () => {
		env = setupTestEnvironment("pi-lens-grammar-load-fail-memo-");
		const grammarFile = "tree-sitter-python.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, TRUNCATED_WASM);

		const client = await makeClient(env.tmpDir);
		const decodeError = new Error(
			"Code section extends past end of the module",
		);
		client.LanguageLoader = { load: vi.fn().mockRejectedValue(decodeError) };

		// Resolve once BEFORE the load failure: the preamble check alone passes
		// and memoizes the file as verified — this is the pre-#1564 dead end.
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);

		await client.loadLanguage("python");

		// Post-fix: the same still-on-disk, still-magic-valid file must no
		// longer resolve — the decode failure overrides the positive preamble
		// memo, so a later demand treats the grammar as missing and can
		// re-fetch instead of handing the same broken file to Language.load
		// forever.
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();

		// Once the file is actually replaced (the re-download an unmocked
		// ensureGrammar would perform), resolution recovers and a fresh
		// Language.load call can succeed.
		fs.writeFileSync(grammarPath, OTHER_VALID_WASM);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);

		client.LanguageLoader = {
			load: vi.fn().mockResolvedValue({ name: "python" }),
		};
		const recovered = await client.loadLanguage("python");
		expect(recovered).toEqual({ name: "python" });
	});

	it("does not record a decode-failure degradation for an abort-shaped error", async () => {
		env = setupTestEnvironment("pi-lens-grammar-load-fail-abort-");
		const grammarFile = "tree-sitter-python.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, TRUNCATED_WASM);

		const client = await makeClient(env.tmpDir);
		client.LanguageLoader = {
			load: vi
				.fn()
				.mockRejectedValue(new Error("Aborted(native code called abort())")),
		};

		const result = await client.loadLanguage("python");

		expect(result).toBeNull();
		// The existing wasm-abort path owns this — it must not ALSO get a
		// "grammar-blocked" load-failure record (double-reporting one failure
		// under two different kinds).
		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group).toBeUndefined();
		expect(
			getDegradationSummary().find((g) => g.kind === "wasm-abort")?.count,
		).toBe(1);
	});
});
