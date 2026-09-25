/**
 * Regression tests for #1592: `TreeSitterClient.init()` retried a dead
 * `import()` — and round 2 (adversarial review on PR #1698) found the first
 * fix over-corrected.
 *
 * `init()` calls `loadWebTreeSitter()` (clients/deps/web-tree-sitter.js),
 * which dynamically `import()`s the package via a resolved `file://` URL.
 * Node's ESM loader permanently memoizes a module record that threw during
 * EVALUATION: a later `import()` of the same URL replays the cached
 * rejection instead of re-attempting the load (the class this issue sweeps,
 * also documented in clients/lazy-import.ts and fixed for the analogous
 * ast-grep-napi loader in #1575/#1567).
 *
 * Round 1 latched on ANY `loadWebTreeSitter()` rejection, unconditionally
 * and for the process lifetime of the client. Two round-2 findings:
 *
 * - F1: a RESOLUTION-shaped rejection (`ERR_MODULE_NOT_FOUND`, a transient
 *   fs errno before `import()` gets to evaluate) recovers once whatever was
 *   missing/busy appears — round 1's unconditional latch made that dead too,
 *   even though `lazy-import.ts`'s own docstring says resolution failures
 *   ARE recoverable. `classifyWebTreeSitterLoadFailure` now draws that line
 *   (mirrors `classifyAstGrepLoadFailure` in
 *   clients/dispatch/runners/ast-grep-napi.ts): only an EVALUATION-shaped
 *   rejection latches.
 * - F2: the latch was process-lifetime with no `session_start` re-arm — the
 *   #1567/#1575 precedent this fix cites re-arms `sgSessionHold` via
 *   `resetAstGrepNapiLoadState()` in `resetDispatchBaselines()`. The latch is
 *   now session-scoped: `resetLoadStateForSession()` on `TreeSitterClient`,
 *   exposed as `resetTreeSitterClientLoadState()` (tree-sitter-shared.ts),
 *   wired into `resetDispatchBaselines()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("TreeSitterClient.init() web-tree-sitter load latch (#1592)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("../../clients/deps/web-tree-sitter.js");
	});

	it("latches on an evaluation-shaped rejection (no `code` at all — a module's own top-level throw)", async () => {
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(
					new TypeError("undefined is not a function (evaluating glue code)"),
				);
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();

		const first = await client.init();
		const second = await client.init();
		const third = await client.init();

		expect(first).toBe(false);
		expect(second).toBe(false);
		expect(third).toBe(false);
		// The original bug: without a latch, every call to init() re-invokes
		// loadWebTreeSitter() and replays the same cached ESM rejection. Fixed
		// behavior for an evaluation-shaped error: exactly one attempt.
		expect(loadCalls).toBe(1);
	});

	it("still latches on a load rejection classified as a wasm abort", async () => {
		// wasmAborted is unaffected by this fix — a genuine Emscripten abort
		// still latches via the existing reportWasmAbort path (unchanged
		// behavior, asserted here so the new latch doesn't shadow it).
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(new Error("Aborted(native code)"));
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();

		await client.init();
		await client.init();

		expect(loadCalls).toBe(1);
		expect(client.isAvailable()).toBe(false);
	});

	it("F1 probe: a resolution-shaped rejection recovers on the next init() call, not latched forever", async () => {
		// The reviewer's exact probe: reject once with a resolution-shaped
		// error, then succeed. Pre-fix (round 1's unconditional latch), init()
		// would return false forever even though the module was now
		// resolvable — contradicting lazy-import.ts's own docstring, which
		// says a resolution failure recovers.
		let loadCalls = 0;
		const okModule = {
			Parser: Object.assign(function Parser() {}, {
				init: vi.fn().mockResolvedValue(undefined),
			}),
			Language: {},
		};
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				if (loadCalls === 1) {
					return Promise.reject(
						Object.assign(new Error("Cannot find module 'web-tree-sitter'"), {
							code: "ERR_MODULE_NOT_FOUND",
						}),
					);
				}
				return Promise.resolve(okModule);
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();
		// biome-ignore lint/suspicious/noExplicitAny: poke a private for the probe
		vi.spyOn(client as any, "resolveWebTreeSitterAsset").mockReturnValue(
			"/fake/tree-sitter.wasm",
		);

		const first = await client.init();
		expect(first).toBe(false);

		const second = await client.init();
		expect(second).toBe(true);
		expect(loadCalls).toBe(2);
	});

	it("F1 mutation-proof: an UNCLASSIFIED code still latches (does not invert to resolution-shaped)", async () => {
		// An error carrying a `code` that is NOT in the resolution allowlist —
		// e.g. a native-binding-style failure — must still be treated as
		// evaluation-shaped and latch. This guards against a classifier that
		// accidentally inverts to "unknown code => recoverable".
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(
					Object.assign(new Error("failed to load native binding"), {
						code: "ERR_DLOPEN_FAILED",
					}),
				);
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();

		await client.init();
		await client.init();

		expect(loadCalls).toBe(1);
	});

	it("F2 probe: resetLoadStateForSession() re-arms the latch for one fresh attempt", async () => {
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(new TypeError("boom at eval time"));
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();

		await client.init();
		await client.init();
		expect(loadCalls).toBe(1); // latched, per the evaluation-shaped test above

		client.resetLoadStateForSession();

		await client.init();
		expect(loadCalls).toBe(2); // re-armed: exactly one fresh attempt

		await client.init();
		expect(loadCalls).toBe(2); // and re-latches after that attempt fails again
	});

	it("F2 probe: resetLoadStateForSession() does not clear a genuine wasm abort", async () => {
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(new Error("Aborted(native code)"));
			},
		}));

		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient();

		await client.init();
		client.resetLoadStateForSession();
		const afterReset = await client.init();

		expect(afterReset).toBe(false);
		expect(loadCalls).toBe(1);
		expect(client.isAvailable()).toBe(false);
	});
});
