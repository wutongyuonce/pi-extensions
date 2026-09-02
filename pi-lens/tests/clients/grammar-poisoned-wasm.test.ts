/**
 * Regression tests for #1548: a 200 OK that is not a wasm module must never
 * become a grammar file on disk.
 *
 * A captive portal (airport wifi, corporate proxy) intercepts the CDN request
 * and answers 200 with its own login page. Pre-fix, `res.ok` was the only
 * gate, so that HTML was written to disk as `tree-sitter-<lang>.wasm`:
 *
 *   - `downloadGrammarDetailed` reported success, so no cooldown was armed and
 *     nothing was recorded — #1536's retry machinery never saw a failure;
 *   - `resolveGrammarFile` then found the garbage file on every later check, so
 *     the grammar read as "available" forever while `Language.load` failed on
 *     every parse. Only deleting the file by hand recovered.
 *
 * The fix validates the wasm preamble (`\0asm`) before writing and classifies a
 * non-wasm body as a RETRYABLE failure, so it flows through the same
 * cooldown/notification/ledger path #1536 built. `resolveGrammarFile` also
 * rejects a non-wasm file already on disk, which is the only way a file
 * poisoned before this shipped can ever be replaced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	describeNonWasmBody,
	downloadGrammarDetailed,
	fileHasWasmMagic,
	hasWasmMagic,
} from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

/** A minimal but genuinely valid wasm module header: magic + version 1. */
const WASM_HEADER = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

const CAPTIVE_PORTAL_PAGE =
	"<!DOCTYPE html>\n<html><head><title>Sign in to WiFi</title></head>\n<body>Please log in to continue.</body></html>\n";

function wasmResponse(): Response {
	return new Response(WASM_HEADER, { status: 200 });
}

function captivePortalResponse(): Response {
	return new Response(CAPTIVE_PORTAL_PAGE, {
		status: 200,
		headers: { "content-type": "text/html" },
	});
}

type EnsureGrammarClient = {
	ensureGrammar(file: string): Promise<boolean>;
	resolveGrammarFile(file: string): string | undefined;
	grammarSourceDirs(): string[];
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
};

/**
 * A client whose only grammar directory is `dir` — both the resolve sweep and
 * the fetch target — so the real `resolveGrammarFile` runs against a directory
 * the test controls, instead of the repo's populated grammars dir.
 */
async function makeClient(dir: string): Promise<EnsureGrammarClient> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	const client = new TreeSitterClient() as unknown as EnsureGrammarClient;
	client.grammarsDir = dir;
	vi.spyOn(client, "grammarSourceDirs").mockReturnValue([dir]);
	vi.spyOn(client, "grammarsWriteDir").mockReturnValue(dir);
	return client;
}

describe("non-wasm grammar download (#1548)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		vi.useFakeTimers();
		env = setupTestEnvironment("pi-lens-grammar-poison-");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		removeTempDirSync(env.tmpDir);
	});

	describe("magic-number helpers", () => {
		it("accepts the wasm preamble and rejects everything else", () => {
			expect(hasWasmMagic(WASM_HEADER)).toBe(true);
			expect(hasWasmMagic(new TextEncoder().encode(CAPTIVE_PORTAL_PAGE))).toBe(
				false,
			);
			// Short reads must not pass by accident: a truncated body is not a
			// module, and indexing past the end yields undefined, not a match.
			expect(hasWasmMagic(new Uint8Array([0x00, 0x61, 0x73]))).toBe(false);
			expect(hasWasmMagic(new Uint8Array())).toBe(false);
		});

		it("reads a file's preamble and treats an unreadable path as not-wasm", () => {
			const good = path.join(env.tmpDir, "good.wasm");
			const bad = path.join(env.tmpDir, "bad.wasm");
			const tiny = path.join(env.tmpDir, "tiny.wasm");
			fs.writeFileSync(good, WASM_HEADER);
			fs.writeFileSync(bad, CAPTIVE_PORTAL_PAGE);
			fs.writeFileSync(tiny, "ab");

			expect(fileHasWasmMagic(good)).toBe(true);
			expect(fileHasWasmMagic(bad)).toBe(false);
			expect(fileHasWasmMagic(tiny)).toBe(false);
			expect(fileHasWasmMagic(path.join(env.tmpDir, "absent.wasm"))).toBe(
				false,
			);
			// A directory is openable but unreadable as a file — must not throw.
			expect(fileHasWasmMagic(env.tmpDir)).toBe(false);
		});

		it("names the failure shape without echoing the body", () => {
			const html = describeNonWasmBody(
				new TextEncoder().encode(CAPTIVE_PORTAL_PAGE),
			);
			expect(html).toContain("HTML");
			expect(html).toContain("captive portal");
			// Shape and size only — never the portal's own text, which ends up in a
			// user-facing notification.
			expect(html).not.toContain("Sign in to WiFi");
			expect(html).toContain(`${CAPTIVE_PORTAL_PAGE.length} bytes`);

			expect(describeNonWasmBody(new Uint8Array())).toContain("empty body");
			expect(describeNonWasmBody(new Uint8Array([1, 2, 3, 4]))).toContain(
				"non-wasm data",
			);
		});
	});

	it("refuses to write a 200 response whose body is not a wasm module", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(captivePortalResponse());
		const grammarFile = "tree-sitter-portal.wasm";

		const result = await downloadGrammarDetailed(env.tmpDir, grammarFile);

		// Classified exactly like a network failure, so #1536's cooldown ladder
		// picks it up: failed, retryable, with the real shape named.
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.reason).toContain("HTML");
		// The whole point: nothing lands on disk to poison the path.
		expect(fs.existsSync(path.join(env.tmpDir, grammarFile))).toBe(false);
	});

	it("writes a body that IS a wasm module", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(wasmResponse());
		const grammarFile = "tree-sitter-real.wasm";

		expect(await downloadGrammarDetailed(env.tmpDir, grammarFile)).toEqual({
			ok: true,
			retryable: true,
		});
		expect(
			fs
				.readFileSync(path.join(env.tmpDir, grammarFile))
				.equals(Buffer.from(WASM_HEADER)),
		).toBe(true);
	});

	it("treats a captive-portal 200 as a retryable ensure failure, then recovers", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-captive.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(captivePortalResponse());

		// Pre-fix this returned TRUE and left the portal's HTML on disk.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(fs.existsSync(grammarPath)).toBe(false);
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();

		// The failure went through the SAME machinery as an offline fetch: the
		// user was told once, and the ledger names the actual shape rather than
		// blaming the package manager.
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(notifyUserDegradation.mock.calls[0][0]).toContain("HTML");
		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.find((r) => r.subject === grammarFile)?.reason,
		).toContain("HTML");

		// A cooldown is armed, so the portal is not hammered on every parse.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Off the portal, past the cooldown: the download retries and lands.
		vi.advanceTimersByTime(60_000);
		fetchSpy.mockResolvedValueOnce(wasmResponse());
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
	});

	it("ignores a grammar file already poisoned on disk and re-fetches over it", async () => {
		const grammarFile = "tree-sitter-already-poisoned.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		// A file written by a captive-portal download that happened BEFORE this
		// fix shipped. Nothing deletes it, so the resolve path is the only place
		// that can notice.
		fs.writeFileSync(grammarPath, CAPTIVE_PORTAL_PAGE);

		const client = await makeClient(env.tmpDir);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(wasmResponse());

		// Pre-fix, existsSync was the whole test: the poisoned path resolved,
		// ensureGrammar short-circuited to true, and Language.load failed forever.
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// The re-download replaced the garbage, so the path resolves again.
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
		expect(fs.readFileSync(grammarPath).equals(Buffer.from(WASM_HEADER))).toBe(
			true,
		);

		// The ignored file was recorded once, not once per resolve call.
		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.find((r) => r.subject === grammarFile)?.reason,
		).toContain("not a wasm module");
	});

	it("records the ignored file again after a session boundary (#1560 review F1)", async () => {
		const grammarFile = "tree-sitter-across-sessions.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, CAPTIVE_PORTAL_PAGE);

		const client = await makeClient(env.tmpDir);
		const countFor = (): number | undefined =>
			getDegradationSummary().find((g) => g.kind === "grammar-blocked")?.count;

		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);
		// Same session, same file: one ring slot, no flood.
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);

		// A new session starts (handleSessionStart calls resetDegradationLedger
		// first thing) while the poisoned file is STILL on disk. The report gate
		// is a client-lifetime Set, so without a session-scoped re-arm the ledger
		// comes back empty and the degradation is invisible for the rest of the
		// process — state that must re-arm at session_start cannot hide behind a
		// process-lifetime latch.
		resetDegradationLedger();
		expect(countFor()).toBeUndefined();
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();
		expect(countFor()).toBe(1);
	});

	it("re-checks a verified grammar once the file on disk changes", async () => {
		const grammarFile = "tree-sitter-restamped.wasm";
		const grammarPath = path.join(env.tmpDir, grammarFile);
		fs.writeFileSync(grammarPath, WASM_HEADER);

		const client = await makeClient(env.tmpDir);
		// Verified once, then served from the memo — no second header read.
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);

		// Something replaces the file with non-wasm bytes. A memo keyed only on
		// the path would keep vouching for it (defect shape 6); keyed on
		// size + mtimeMs, the change invalidates it and the preamble is re-read.
		fs.writeFileSync(grammarPath, CAPTIVE_PORTAL_PAGE);
		expect(client.resolveGrammarFile(grammarFile)).toBeUndefined();

		// And back again, so the memo doesn't latch the negative either.
		fs.writeFileSync(grammarPath, WASM_HEADER);
		expect(client.resolveGrammarFile(grammarFile)).toBe(grammarPath);
	});

	it("arms a cooldown when the ensure task throws instead of returning", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-throwing.wasm";

		// Force an exception out of the ensure task's body. Nothing throws there
		// today; this stands in for the refactor that lets one escape. Pre-fix the
		// whole `else` arm was skipped, so NO cooldown was armed and the promise
		// rejected — the ensureGrammar call below would reject, not resolve.
		const writeDirSpy = vi
			.spyOn(client, "grammarsWriteDir")
			.mockImplementation(() => {
				throw new Error("EACCES: grammars dir vanished mid-resolve");
			});
		client.grammarsDir = "";
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(client.ensureGrammar(grammarFile)).resolves.toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(notifyUserDegradation.mock.calls[0][0]).toContain(
			"EACCES: grammars dir vanished mid-resolve",
		);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "grammar-blocked", count: 1 }),
			]),
		);

		// The cooldown really is armed: a demand inside the window never re-enters
		// the task, so the throwing resolution is not repeated on every parse.
		writeDirSpy.mockClear();
		await expect(client.ensureGrammar(grammarFile)).resolves.toBe(false);
		expect(writeDirSpy).not.toHaveBeenCalled();

		// Past the cooldown, a recovered environment retries and succeeds.
		writeDirSpy.mockReturnValue(env.tmpDir);
		fetchSpy.mockResolvedValueOnce(wasmResponse());
		vi.advanceTimersByTime(60_000);
		await expect(client.ensureGrammar(grammarFile)).resolves.toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
