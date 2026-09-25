/**
 * Regression tests for #1536: a failed grammar download must not latch for
 * the session.
 *
 * `TreeSitterClient.ensureGrammar` de-dupes concurrent fetches of the same
 * grammar via `grammarEnsurePromises`, a `Map<string, Promise<boolean>>`. Pre-
 * fix, that map retained the SETTLED promise forever, so a `false` from one
 * offline moment (DNS hiccup, CDN blip, proxy stall) disabled the language's
 * tree-sitter features for the rest of the process — the #1494 permanent-
 * latch class, in the download domain.
 *
 * The fix evicts the settled entry on resolution and adds a bounded cooldown
 * (the `transientRetryDelayMs` shape from availability-policy.ts) so a
 * hard-down CDN is not re-hit on every parse, while a later demand — once the
 * cooldown expires — gets a fresh attempt.
 */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/**
 * A valid wasm module header (magic + version). Any body standing in for a
 * successful grammar download has to start with the wasm preamble now that
 * the downloader validates it (#1548) — three arbitrary bytes are rejected as
 * a poisoned download, which is the whole point of that fix.
 */
const WASM_HEADER = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

type EnsureGrammarClient = {
	ensureGrammar(file: string): Promise<boolean>;
	resolveGrammarFile(file: string): string | undefined;
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
};

async function makeClient(writeDir: string): Promise<EnsureGrammarClient> {
	const { TreeSitterClient } =
		await import("../../clients/tree-sitter-client.js");
	const client = new TreeSitterClient() as unknown as EnsureGrammarClient;
	// Force ensureGrammar past the "already on disk" short-circuit and give it
	// a real write dir to fetch into, instead of the real (junctioned)
	// grammars dir the constructor found.
	client.grammarsDir = "";
	vi.spyOn(client, "resolveGrammarFile").mockReturnValue(undefined);
	vi.spyOn(client, "grammarsWriteDir").mockReturnValue(writeDir);
	return client;
}

describe("grammar download retry after failure (#1536)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		vi.useFakeTimers();
		env = setupTestEnvironment("pi-lens-grammar-retry-");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		removeTempDirSync(env.tmpDir);
	});

	it("retries a failed grammar download after cooldown and succeeds once the fetch recovers", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-fake-lang.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("network unreachable"));

		// First demand: the download fails (transient network error).
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "grammar-blocked", count: 1 }),
			]),
		);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(false);

		// A demand made WHILE the cooldown is still live must not hit the network
		// again — this is the "not hammered" half of the fix. NOT red on pre-fix
		// code: pre-fix also returns `false` here (it always did, forever), so
		// this assertion alone doesn't distinguish the fix from the bug — it
		// only rules out a naive "just retry every time" fix that would have
		// hammered the CDN.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1); // no re-fetch while cooling down

		// Advance past the cooldown and let the network recover.
		vi.advanceTimersByTime(60_000);
		fetchSpy.mockResolvedValueOnce(new Response(WASM_HEADER, { status: 200 }));

		// THIS is the assertion that is red on pre-fix code: pre-fix, the
		// settled `false` promise was cached forever, so this call — and every
		// later call for the rest of the process, even long after the network
		// recovered — would also return `false`.
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(true);
	});

	it("shares one fetch across concurrent demands for the same grammar", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-concurrent-lang.wasm";

		let resolveFetch!: (value: Response) => void;
		const fetchGate = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockReturnValue(fetchGate as unknown as Promise<Response>);

		const first = client.ensureGrammar(grammarFile);
		const second = client.ensureGrammar(grammarFile);

		resolveFetch(new Response("no", { status: 500 }));
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).toBe(false);
		expect(secondResult).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// Both demands see the same failed outcome from the one shared attempt;
		// the failure notification still fires only once.
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
	});

	it("caches a successful grammar download (no re-fetch on the next demand)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-cached-lang.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(WASM_HEADER, { status: 200 }));

		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(true);

		// Second demand: the file is now really on disk, so the un-mocked
		// resolveGrammarFile would find it. Simulate that by letting the mock
		// return the real path instead of undefined.
		(client.resolveGrammarFile as ReturnType<typeof vi.fn>).mockReturnValue(
			`${env.tmpDir}/${grammarFile}`,
		);
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	// #1536 PR #1542 review findings (F1-F6) below.

	it("keeps cooldowns and notifications isolated per grammar file (F2 cross-language isolation)", async () => {
		const client = await makeClient(env.tmpDir);
		const langA = "tree-sitter-lang-a.wasm";
		const langB = "tree-sitter-lang-b.wasm";

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes(langA)) {
				return new Response("no", { status: 500 });
			}
			return new Response(WASM_HEADER, { status: 200 });
		});

		// langA fails and is now cooling down.
		expect(await client.ensureGrammar(langA)).toBe(false);
		// langB, requested right after, must not be blocked by langA's cooldown
		// or share its notification gate — a per-grammar Map keyed by filename,
		// not a single client-wide latch.
		expect(await client.ensureGrammar(langB)).toBe(true);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(notifyUserDegradation.mock.calls[0][0]).toContain(langA);
	});

	it("gives the 'no writable directory' arm the same cooldown + one-time notification as a download failure (F2)", async () => {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as EnsureGrammarClient;
		const grammarFile = "tree-sitter-no-write-dir.wasm";
		client.grammarsDir = "";
		vi.spyOn(client, "resolveGrammarFile").mockReturnValue(undefined);
		const writeDirSpy = vi
			.spyOn(client, "grammarsWriteDir")
			.mockReturnValue(undefined); // simulates web-tree-sitter unresolvable (pi temp-compile case)
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		// Repeated demands while unresolved must not re-run the failing
		// resolution sweep (and must not re-notify) on every call.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		// Only the FIRST call actually ran the resolution sweep and recorded a
		// failure; the following two were short-circuited by the still-live
		// cooldown before ever re-entering the task -- exactly the "no
		// hammering" behavior the cooldown exists for.
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "grammar-blocked", count: 1 }),
			]),
		);

		// Once the environment recovers (web-tree-sitter becomes resolvable) and
		// the cooldown expires, the next demand retries instead of staying
		// silently stuck.
		writeDirSpy.mockReturnValue(env.tmpDir);
		fetchSpy.mockResolvedValueOnce(new Response(WASM_HEADER, { status: 200 }));
		vi.advanceTimersByTime(60_000);
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("latches a durable 404 but keeps retrying a transient failure (F4)", async () => {
		const client = await makeClient(env.tmpDir);
		const durable = "tree-sitter-genuinely-absent.wasm";
		const transient = "tree-sitter-network-blip.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url.includes(durable)) {
					return new Response("not found", { status: 404 });
				}
				return new Response("server error", { status: 500 });
			});

		expect(await client.ensureGrammar(durable)).toBe(false);
		expect(await client.ensureGrammar(transient)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		// Advance well past even the MAX transient cooldown (5 min).
		vi.advanceTimersByTime(10 * 60_000);

		// The transient failure retries...
		expect(await client.ensureGrammar(transient)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		// ...but the durable 404 never does: the CDN already gave an
		// authoritative answer that a retry cannot change.
		expect(await client.ensureGrammar(durable)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("re-notifies after a fail -> success -> fail cycle (streak reset on success)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-flaky-lang.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("no", { status: 500 }));
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		fetchSpy.mockResolvedValueOnce(new Response(WASM_HEADER, { status: 200 }));
		expect(await client.ensureGrammar(grammarFile)).toBe(true);

		// Grammar goes missing again (e.g. the on-disk file was removed) and the
		// download fails again -- this is a NEW streak, so it must notify again
		// rather than staying silent because "we already told them once".
		(client.resolveGrammarFile as ReturnType<typeof vi.fn>).mockReturnValue(
			undefined,
		);
		fetchSpy.mockResolvedValueOnce(new Response("no", { status: 500 }));
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(2);
	});

	it("re-arms the notification on a new session even mid-streak, but not for an unchanged repeat within one session (F5/F6)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-session-boundary.wasm";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("no", { status: 500 }),
		);

		// Pre-seed the failure streak so the cooldown is already saturated at
		// the 5-minute cap (attempts >= 5) -- isolates the session-boundary
		// effect from the backoff-escalation effect, since without saturation a
		// second failure would re-notify anyway just because the delay changed.
		(
			client as unknown as { grammarFailureAttempts: Map<string, number> }
		).grammarFailureAttempts.set(grammarFile, 4);

		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		const firstMessage = notifyUserDegradation.mock.calls[0][0] as string;
		expect(firstMessage).toContain("300s");

		vi.advanceTimersByTime(300_000);
		// Same session, same (saturated) delay: repeating verdict, no new
		// information for the user -- must NOT re-notify.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);

		// A new session starts (handleSessionStart calls resetDegradationLedger
		// first thing) while the grammar is STILL failing continuously.
		resetDegradationLedger();
		vi.advanceTimersByTime(300_000);
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(2);
	});

	it("re-notifies as the backoff escalates through distinct cooldown tiers, with the current delay in the message (F6)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-escalating-lang.wasm";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("no", { status: 500 }),
		);

		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation.mock.calls[0][0]).toContain("30s");

		vi.advanceTimersByTime(30_000);
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation.mock.calls[1][0]).toContain("60s");

		vi.advanceTimersByTime(60_000);
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation.mock.calls[2][0]).toContain("120s");

		expect(notifyUserDegradation).toHaveBeenCalledTimes(3);
	});

	it("bumps the ledger count for repeated failures of one grammar without flooding its ring buffer (F1)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-repeat-failure.wasm";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("no", { status: 500 }),
		);

		for (let i = 0; i < 5; i++) {
			await client.ensureGrammar(grammarFile);
			vi.advanceTimersByTime(300_000); // clears any cooldown tier
		}

		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "grammar-blocked");
		expect(group).toBeDefined();
		// The exact event count is preserved...
		expect(group?.count).toBe(5);
		// ...but repeated failures of the SAME subject occupy a single ring
		// slot (updated in place), not five -- otherwise 20 cooldown cycles of
		// one grammar would evict everything else recorded under this kind.
		const entriesForSubject = group?.latestReasons.filter(
			(r) => r.subject === grammarFile,
		);
		expect(entriesForSubject).toHaveLength(1);
	});
});
