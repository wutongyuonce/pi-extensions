/**
 * Regression tests for #1564: a truncated grammar download whose first four
 * bytes are a genuine wasm preamble still poisons the grammar path
 * permanently.
 *
 * #1548 / PR #1560 validated the `\0asm` magic number before writing, which
 * stops a captive portal's HTML page from becoming a
 * `tree-sitter-<lang>.wasm`. A body that is a genuine wasm module PREFIX — a
 * connection dropped mid-transfer, a proxy that truncates, a partial CDN
 * response — passes that check, because the magic number is the first thing
 * the real file contains. Pre-#1564:
 *
 *   - the truncated bytes were written and the download reported success, so
 *     no cooldown was armed and nothing was recorded;
 *   - `resolveGrammarFile` vouched for the file (preamble check passes) and
 *     memoized that verdict;
 *   - `Language.load` failed with a decode error ("Code section extends past
 *     end of the module") that is NOT abort-shaped, so `reportWasmAbort`
 *     ignored it and the catch only `dbg`'d and returned `null`;
 *   - nothing was recorded, no cooldown was armed, and no re-download was
 *     ever attempted — the language degraded silently for the rest of the
 *     process, exactly like #1548, and manually deleting the file was the
 *     only recovery.
 *
 * The fix adds two checks to `downloadGrammarDetailed` (a sha256 verify
 * against the pinned `scripts/grammars.lock.json` manifest when available,
 * and a Content-Length compare as the cheaper fallback when it isn't), and
 * closes the load-time diagnosis gap in `loadLanguage`: a `Language.load`
 * failure on a file resolution just vouched for now records a degradation
 * and invalidates the resolve memo so the next demand can re-fetch.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_setGrammarManifestForTests,
	downloadGrammarDetailed,
	GRAMMAR_FILES,
	GRAMMAR_SOURCE_OVERRIDES,
	type GrammarManifest,
} from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

/** A genuinely valid wasm module header: magic + version 1 — same fixture
 * shape #1548's own tests use, but short enough to stand in for a connection
 * that dropped after the preamble. Passes `hasWasmMagic` while being nowhere
 * near a real grammar's byte count. */
const TRUNCATED_WASM = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fakeManifest(
	overrides: Partial<GrammarManifest> = {},
): GrammarManifest {
	return {
		package: "tree-sitter-wasms",
		version: "0.1.13",
		grammars: {},
		...overrides,
	};
}

describe("truncated-but-magic-valid grammar download (#1564)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		env = setupTestEnvironment("pi-lens-grammar-truncation-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_setGrammarManifestForTests(undefined);
		removeTempDirSync(env.tmpDir);
	});

	describe("sha256 verification against the pinned manifest", () => {
		it("rejects a magic-valid body whose sha256 mismatches the pinned hash", async () => {
			const grammarFile = "tree-sitter-fake.wasm";
			_setGrammarManifestForTests(
				fakeManifest({
					grammars: {
						// A hash that does NOT match TRUNCATED_WASM's real digest —
						// simulating the pinned manifest describing the FULL grammar
						// while the CDN only delivered a prefix of it.
						[grammarFile]:
							"sha256:0000000000000000000000000000000000000000000000000000000000000000",
					},
				}),
			);
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(TRUNCATED_WASM, { status: 200 }),
			);

			const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

			expect(result.ok).toBe(false);
			expect(result.retryable).toBe(true);
			expect(result.reason).toContain("sha256");
			// The whole point: a truncated-but-magic-valid body never lands on
			// disk to poison the resolve path.
			expect(fs.existsSync(path.join(env.tmpDir, grammarFile))).toBe(false);
		});

		it("accepts a body whose sha256 matches the pinned hash", async () => {
			const grammarFile = "tree-sitter-fake-good.wasm";
			_setGrammarManifestForTests(
				fakeManifest({
					grammars: { [grammarFile]: sha256Of(TRUNCATED_WASM) },
				}),
			);
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(TRUNCATED_WASM, { status: 200 }),
			);

			const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

			expect(result).toEqual({ ok: true, retryable: true });
			expect(
				fs
					.readFileSync(path.join(env.tmpDir, grammarFile))
					.equals(Buffer.from(TRUNCATED_WASM)),
			).toBe(true);
		});

		it("every currently-mapped grammar (including overrides) has a pinned hash", () => {
			// Coverage for the issue's second named snag: an override entry
			// missing its own hash would silently fall through to the weaker
			// Content-Length check on every download, forever.
			_setGrammarManifestForTests(undefined);
			const raw = fs.readFileSync(
				path.resolve(process.cwd(), "scripts/grammars.lock.json"),
				"utf-8",
			);
			const manifest = JSON.parse(raw) as GrammarManifest;
			for (const file of GRAMMAR_FILES) {
				// A grammar is pinned in exactly one of two places: `grammars` for
				// anything downloaded, `vendored` for anything we build and commit
				// (#1522). The invariant is that EVERY mapped grammar is pinned
				// somewhere — a vendored grammar never reaches the download path,
				// so its hash guards the committed bytes instead of a transfer.
				const pinned =
					manifest.grammars[file] ?? manifest.vendored?.[file]?.sha256;
				expect(pinned, `${file} lacks a pinned hash`).toMatch(
					/^sha256:[0-9a-f]{64}$/,
				);
			}
			for (const file of Object.keys(GRAMMAR_SOURCE_OVERRIDES)) {
				expect(
					manifest.grammars[file],
					`override ${file} lacks a pinned hash`,
				).toMatch(/^sha256:[0-9a-f]{64}$/);
			}
		});
	});

	describe("Content-Length fallback when no pinned hash is available", () => {
		it("rejects a magic-valid body shorter than the declared Content-Length", async () => {
			const grammarFile = "tree-sitter-unmapped.wasm";
			// No manifest entry for this filename (empty grammars map) — the sha
			// check has nothing to compare against, so Content-Length is the only
			// signal available.
			_setGrammarManifestForTests(fakeManifest());
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(TRUNCATED_WASM, {
					status: 200,
					headers: { "content-length": String(TRUNCATED_WASM.length * 10) },
				}),
			);

			const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

			expect(result.ok).toBe(false);
			expect(result.retryable).toBe(true);
			expect(result.reason).toContain("Content-Length");
			expect(fs.existsSync(path.join(env.tmpDir, grammarFile))).toBe(false);
		});

		it("accepts a body whose length matches the declared Content-Length", async () => {
			const grammarFile = "tree-sitter-unmapped-good.wasm";
			_setGrammarManifestForTests(fakeManifest());
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(TRUNCATED_WASM, {
					status: 200,
					headers: { "content-length": String(TRUNCATED_WASM.length) },
				}),
			);

			const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

			expect(result).toEqual({ ok: true, retryable: true });
		});

		it("has no Content-Length signal to check without a manifest entry or header (unchanged #1548 behavior)", async () => {
			const grammarFile = "tree-sitter-no-signal.wasm";
			_setGrammarManifestForTests(fakeManifest());
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(TRUNCATED_WASM, { status: 200 }),
			);

			const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

			expect(result).toEqual({ ok: true, retryable: true });
		});
	});

	// #1564 G3: a missing/unloadable manifest silently downgrades every
	// download to the weaker Content-Length check (or no check at all) — the
	// STRONGEST check being skipped repo-wide needs to be on the record, once
	// per session, not invisible.
	describe("missing-manifest observability", () => {
		it("records a degradation once when the manifest can't be loaded", async () => {
			_setGrammarManifestForTests(null);
			// A `Response` body is a single-use stream — two downloads sharing ONE
			// `mockResolvedValue(new Response(...))` instance means the second
			// `res.arrayBuffer()` reads empty and bails at the magic check before
			// ever reaching `loadGrammarManifest`, so this test would pass even
			// with the once-per-session dedupe deleted entirely (only one real
			// call ever happened). A fresh `Response` per invocation is required
			// for the second `downloadGrammarDetailed` call to actually run.
			vi.spyOn(globalThis, "fetch").mockImplementation(
				async () => new Response(TRUNCATED_WASM, { status: 200 }),
			);

			await downloadGrammarDetailed(env.tmpDir, "tree-sitter-one.wasm");
			await downloadGrammarDetailed(env.tmpDir, "tree-sitter-two.wasm");

			const group = getDegradationSummary().find(
				(g) => g.kind === "grammar-blocked",
			);
			// One record for the missing manifest itself, not one per download —
			// recordDegradationOnce dedupes on the fixed "grammars.lock.json"
			// subject regardless of how many grammars are fetched.
			const manifestEntries = group?.latestReasons.filter(
				(r) => r.subject === "grammars.lock.json",
			);
			expect(manifestEntries).toHaveLength(1);
			expect(manifestEntries?.[0]?.reason).toContain("manifest is unavailable");
		});
	});
});
