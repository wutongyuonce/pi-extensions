/**
 * Regression tests for #1567: the ast-grep napi load latch had no in-flight
 * dedupe and no session re-arm. Round 2 (adversarial review on PR #1575)
 * found the fix's classifier was inverted and its transient-retry path was
 * dead code; these tests were rewritten to match the corrected design.
 *
 * `loadSg()` in clients/dispatch/runners/ast-grep-napi.ts guards the native
 * `@ast-grep/napi` addon load. Two real callers race for it — the per-edit
 * fallback runner and the session-start project scanner
 * (clients/project-diagnostics/scanner.ts). Pre-fix, the module-level
 * "attempted" flag was set before the load and read by a SECOND caller as
 * "already tried" while the first load was still pending and about to
 * succeed — a false-negative STARVATION (the second caller got back
 * `undefined` for a load that was in flight and would have succeeded), not
 * a duplicate `import()`. Once any load failed, the flag latched for the
 * rest of the PROCESS, surviving every session boundary — the
 * #1266/#1490/#1497/#1535/#1536 shape.
 *
 * The fix shares one in-flight promise across callers (evicted on settle,
 * #1536's pattern) so no caller starves, and every failure — transient or
 * genuine — holds until `resetAstGrepNapiLoadState()` re-arms it at
 * session_start. There is no in-process cooldown-then-retry: `loadAstGrepNapi()`
 * (clients/deps/ast-grep-napi.ts) dynamically imports the addon via a
 * `file://` URL, and Node's ESM loader permanently memoizes a module record
 * that threw during evaluation, so re-importing the same href would just
 * replay the cached rejection. A classifier still distinguishes transient
 * (a narrow errno allowlist) from genuine (everything else, including any
 * unrecognized native-binding failure) purely to make the degradation-ledger
 * message honest about what happened — not to change retry behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ast-grep napi load latch (#1567)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("@ast-grep/napi");
		vi.doUnmock("../../../../clients/deps/ast-grep-napi.js");
	});

	it("does not starve a concurrent caller while a load is in flight", async () => {
		// Mock the centralized deps accessor directly (rather than the raw npm
		// package) so the timing of the underlying load is fully controlled —
		// `loadAstGrepNapi()` in clients/deps/ast-grep-napi.ts is what `loadSg()`
		// actually calls.
		let loadCalls = 0;
		let resolveLoad: (value: unknown) => void = () => {};
		vi.doMock("../../../../clients/deps/ast-grep-napi.js", () => ({
			loadAstGrepNapi: () => {
				loadCalls += 1;
				return new Promise((resolve) => {
					resolveLoad = resolve;
				});
			},
		}));

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

		// The per-edit fallback runner and the session-start scanner both call
		// loadSg() independently — simulate the race by calling it twice before
		// either settles.
		const first = mod.loadSg();
		const second = mod.loadSg();

		resolveLoad({ ts: { parse: vi.fn() } });
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(loadCalls).toBe(1);
		expect(firstResult).toBe(secondResult);
		expect(firstResult).toBeDefined();
	});

	it("re-arms a genuine-failure latch from a previous session so a fresh session retries", async () => {
		vi.doMock("@ast-grep/napi", () => {
			throw Object.assign(new Error("Cannot find module '@ast-grep/napi'"), {
				code: "MODULE_NOT_FOUND",
			});
		});

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

		// Previous session: the addon load fails for a genuine reason and
		// holds.
		expect(await mod.loadSg()).toBeUndefined();
		expect(await mod.loadSg()).toBeUndefined();

		// A fresh session starts (session_start reset), and this time the
		// addon is actually loadable — e.g. a reinstall repaired it mid-host-
		// lifetime.
		mod.resetAstGrepNapiLoadState();
		vi.doUnmock("@ast-grep/napi");
		vi.doMock("@ast-grep/napi", () => ({ ts: { parse: vi.fn() } }));

		const result = await mod.loadSg();
		expect(result).toBeDefined();
	});

	it("holds a transient (errno-allowlisted) failure for the rest of the session too — an in-process retry cannot succeed", async () => {
		vi.useFakeTimers();
		try {
			vi.doMock("@ast-grep/napi", () => {
				throw Object.assign(new Error("EMFILE: too many open files"), {
					code: "EMFILE",
				});
			});

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

			expect(await mod.loadSg()).toBeUndefined();

			// The mock now resolves to a working module, and we advance well past
			// any cooldown a transient-retry design could plausibly use (5 min,
			// the shared availability-policy ceiling). A design that retries
			// after a cooldown would succeed here; this session must not, because
			// `loadAstGrepNapi()` would just replay Node's cached rejection for
			// the same resolved href — a "retry" that cannot actually reload.
			// Only `resetAstGrepNapiLoadState()` (session_start) may unlatch it.
			vi.doUnmock("@ast-grep/napi");
			vi.doMock("@ast-grep/napi", () => ({ ts: { parse: vi.fn() } }));
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(await mod.loadSg()).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("classifies an unrecognized native-binding failure as genuine, not transient (review F1: inverted default)", async () => {
		// No error `code` at all, and a message that matches none of the known
		// native-load strings — exactly the shape of a real ABI-mismatch/
		// unsupported-arch failure @ast-grep/napi can throw. Pre-fix, this fell
		// through to "transient" by default; it must now be genuine by default.
		vi.doMock("@ast-grep/napi", () => {
			throw new Error(
				"The module was compiled against a different Node.js ABI version",
			);
		});

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

		expect(await mod.loadSg()).toBeUndefined();

		// Imported dynamically, AFTER `vi.resetModules()`, so this resolves to
		// the SAME degradation-ledger module instance `ast-grep-napi.js` itself
		// imported — a static top-level import here would bind an EARLIER
		// instance from before the reset and silently observe nothing.
		const { getDegradationSummary } =
			await import("../../../../clients/degradation-ledger.js");
		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "ast-grep-napi-unavailable");
		expect(group).toBeDefined();
		expect(group?.latestReasons[0]?.reason).toContain(
			"native addon failed to load",
		);
		expect(group?.latestReasons[0]?.reason).not.toContain("transient");
	});

	it("classifies a positively-identified transient errno as transient, and records it as such in the degradation ledger", async () => {
		vi.doMock("@ast-grep/napi", () => {
			throw Object.assign(new Error("resource temporarily unavailable"), {
				code: "EAGAIN",
			});
		});

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

		expect(await mod.loadSg()).toBeUndefined();

		const { getDegradationSummary } =
			await import("../../../../clients/degradation-ledger.js");
		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "ast-grep-napi-unavailable");
		expect(group?.latestReasons[0]?.reason).toContain("transient");
	});

	it("classifies an errno match nested in .cause as genuine when a known-genuine message is anywhere in the chain", async () => {
		// A wrapper Error carrying a transient-looking top-level code, whose
		// .cause is @ast-grep/napi's own terminal message — the known-genuine
		// message anywhere in the chain must win over an errno match elsewhere
		// in that same chain.
		vi.doMock("@ast-grep/napi", () => {
			const cause = new Error("Failed to load native binding");
			throw Object.assign(new Error("wrapped load failure"), {
				code: "EAGAIN",
				cause,
			});
		});

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");

		expect(await mod.loadSg()).toBeUndefined();

		const { getDegradationSummary } =
			await import("../../../../clients/degradation-ledger.js");
		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "ast-grep-napi-unavailable");
		expect(group?.latestReasons[0]?.reason).toContain(
			"native addon failed to load",
		);
	});
});
