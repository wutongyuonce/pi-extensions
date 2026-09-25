/**
 * Regression tests for #1760: a tree-sitter grammar wasm downloaded once is
 * never replaced when this repo bumps the version it is pinned to.
 *
 * `TREE_SITTER_WASMS_VERSION` (or a `SOURCE_OVERRIDES` entry) is embedded in
 * the CDN URL, but the cached file's NAME carries no version —
 * `grammars/tree-sitter-python.wasm`, whatever build produced it.
 * `resolveGrammarFile` used to treat existence + a valid `\0asm` preamble as
 * the whole verdict, so a machine that fetched a grammar under an old pin
 * kept serving it forever, even after this repo moved to a newer build (or
 * changed a `SOURCE_OVERRIDES` entry to fix a broken one, e.g. #255/#427).
 *
 * The fix compares the cached file's sha256 against the CURRENTLY pinned
 * manifest hash (`pinnedGrammarHash`), memoized per `size:mtimeMs` stamp so
 * steady state costs zero extra hashing and never touches the network. A
 * mismatch is treated exactly like a missing file: `resolveGrammarFile`
 * reports it as absent, so `ensureGrammar` re-fetches over it through the
 * existing atomic-write-verified-before-swap path — a failed re-download
 * never destroys the working cached copy until the new one is validated.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.spyOn(fs, "readFileSync")` cannot redefine node:fs's ESM namespace
// export directly (see workspace-topology.test.ts) — wrap it via vi.mock
// instead, keeping the real implementation (via importOriginal) but letting
// the memoization test assert call counts.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_setGrammarManifestForTests,
	type GrammarManifest,
} from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

/** A genuinely valid (if tiny) wasm module: magic + version 1. */
const OLD_BUILD_WASM = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
/** Stand-in for the bytes a NEW pinned build would fetch. */
const NEW_BUILD_WASM = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef,
]);

function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifestPinning(filename: string, bytes: Uint8Array): GrammarManifest {
	return {
		package: "tree-sitter-wasms",
		version: "9.9.9-test",
		grammars: { [filename]: sha256Of(bytes) },
	};
}

type EnsureGrammarClient = {
	ensureGrammar(file: string): Promise<boolean>;
	resolveGrammarFile(file: string): string | undefined;
	grammarSourceDirs(): string[];
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
};

async function makeClient(dir: string): Promise<EnsureGrammarClient> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	const client = new TreeSitterClient() as unknown as EnsureGrammarClient;
	client.grammarsDir = dir;
	vi.spyOn(client, "grammarSourceDirs").mockReturnValue([dir]);
	vi.spyOn(client, "grammarsWriteDir").mockReturnValue(dir);
	return client;
}

describe("cached grammar wasm never refreshes on a pin bump (#1760)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		vi.useFakeTimers();
		env = setupTestEnvironment("pi-lens-grammar-stale-version-");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		_setGrammarManifestForTests(undefined);
		removeTempDirSync(env.tmpDir);
	});

	it("treats a cached wasm matching an OLD pin as absent under a NEW pin", async () => {
		// The manifest's pinned hash is a compiled constant
		// (`TREE_SITTER_WASMS_VERSION`/`grammars.lock.json`), so it only ever
		// moves between process restarts — a version bump ships as a NEW
		// process, never a live edit mid-client-lifetime. Model that
		// realistically: the file on disk was written by an OLDER process
		// (old bytes), and THIS process's manifest already reflects the bump.
		const grammarFile = "tree-sitter-old-pin.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);

		// Sanity check first: a file that DOES match its own pin resolves fine
		// (proves the staleness check isn't just always-false/vacuous).
		_setGrammarManifestForTests(manifestPinning(grammarFile, OLD_BUILD_WASM));
		const matchingClient = await makeClient(env.tmpDir);
		expect(matchingClient.resolveGrammarFile(grammarFile)).toBe(grammarPath);

		// This process's compiled pin has moved on — `--write-manifest`
		// regenerated the hash for the NEW build. The wasm on disk is
		// untouched: still the OLD bytes, from before the bump shipped.
		_setGrammarManifestForTests(manifestPinning(grammarFile, NEW_BUILD_WASM));
		const freshClient = await makeClient(env.tmpDir);

		// Pre-fix: this returned the same path forever — the cached file was
		// never revisited once its preamble had verified once.
		expect(freshClient.resolveGrammarFile(grammarFile)).toBeUndefined();
	});

	it("re-fetches a stale cached grammar and serves the fresh build", async () => {
		const grammarFile = "tree-sitter-stale-refetch.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		_setGrammarManifestForTests(manifestPinning(grammarFile, NEW_BUILD_WASM));

		const client = await makeClient(env.tmpDir);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(NEW_BUILD_WASM, { status: 200 }));

		// The stale cached file must not be served...
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		// ...and ensureGrammar must actually redownload it, landing the new
		// build atomically over the old one (never leaving neither on disk).
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(
			fs.readFileSync(grammarPath).equals(Buffer.from(NEW_BUILD_WASM)),
		).toBe(true);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
	});

	it("does not re-hash an unchanged file on every resolve (memoized per stamp)", async () => {
		const grammarFile = "tree-sitter-memoized.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		_setGrammarManifestForTests(manifestPinning(grammarFile, OLD_BUILD_WASM));

		const client = await makeClient(env.tmpDir);
		const readSpy = vi.mocked(fs.readFileSync);
		readSpy.mockClear();

		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
		const callsAfterFirst = readSpy.mock.calls.filter((c) =>
			String(c[0]).includes(grammarFile),
		).length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		readSpy.mockClear();
		// Repeated resolves against the SAME on-disk bytes (same stamp) must not
		// re-read/re-hash the file — the memo is what keeps this off the hot
		// parse-loop path.
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
		const rereadCalls = readSpy.mock.calls.filter((c) =>
			String(c[0]).includes(grammarFile),
		).length;
		expect(rereadCalls).toBe(0);
	});

	it("trusts a grammar with no pinned manifest entry (can't verify, not a forced refresh)", async () => {
		const grammarFile = "tree-sitter-unpinned.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		_setGrammarManifestForTests({
			package: "tree-sitter-wasms",
			version: "9.9.9-test",
			grammars: {},
		});

		const client = await makeClient(env.tmpDir);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
	});

	it("records a bounded degradation naming the stale grammar", async () => {
		const grammarFile = "tree-sitter-observability.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		_setGrammarManifestForTests(manifestPinning(grammarFile, NEW_BUILD_WASM));

		const client = await makeClient(env.tmpDir);
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		// Repeated resolves while still stale must not flood the ledger.
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();

		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.find((r) => r.subject === grammarFile)?.reason,
		).toContain("pinned manifest hash");
	});

	it("re-records a still-stale grammar in a NEW session's ledger (#1801 review F1)", async () => {
		// The client is a process singleton spanning many sessions
		// (tree-sitter-shared.ts) — a grammar that is STILL stale after a
		// session boundary must still show up in the new session's ledger,
		// mirroring what `reportPoisonedGrammarFile` already does for the
		// non-wasm case (grammar-poisoned-wasm.test.ts's own "records the
		// ignored file again after a session boundary" test).
		const grammarFile = "tree-sitter-across-sessions.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		_setGrammarManifestForTests(manifestPinning(grammarFile, NEW_BUILD_WASM));

		const client = await makeClient(env.tmpDir);
		const countFor = (): number | undefined =>
			getDegradationSummary().find((g) => g.kind === "grammar-blocked")?.count;

		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);
		// Same session, same file: one ring slot, no flood.
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);

		// A new session starts (handleSessionStart calls resetDegradationLedger
		// first thing) while the grammar is STILL stale on disk — nothing
		// re-downloaded it. Pre-fix: `staleGrammarVersionAt`'s memo-hit early
		// return skipped the report entirely, so the new session's ledger came
		// back with NO grammar-blocked entry even though the language is still
		// degraded.
		resetDegradationLedger();
		expect(countFor()).toBeUndefined();
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);
	});

	it("skips the staleness check for vendored grammars", async () => {
		const grammarFile = "tree-sitter-cue.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, OLD_BUILD_WASM);
		// A manifest entry that would fail the hash check if this vendored
		// grammar were subject to it — it must not be.
		_setGrammarManifestForTests(manifestPinning(grammarFile, NEW_BUILD_WASM));

		const client = await makeClient(env.tmpDir);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
	});
});
