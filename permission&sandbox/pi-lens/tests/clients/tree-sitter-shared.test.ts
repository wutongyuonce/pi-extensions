import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../../clients/language-registry.js";
import {
	_resetSharedTreeSitterClientForTests,
	COMPLEXITY_LANGUAGE_IDS,
	getSharedTreeSitterClient,
	getTreeSitterRuntimeStatus,
	isComplexitySupportedFile,
	isTreeSitterWasmAborted,
	markTreeSitterWasmAborted,
	resolveTreeSitterLanguage,
} from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	_resetSharedTreeSitterClientForTests();
});

describe("resolveTreeSitterLanguage", () => {
	it.each([
		[".ts", "typescript"],
		[".mts", "typescript"],
		[".cts", "typescript"],
		[".tsx", "tsx"], // JSX-capable grammar; the scanner derives this same mapping
		[".js", "javascript"],
		[".mjs", "javascript"],
		[".cjs", "javascript"],
		[".jsx", "javascript"],
		[".py", "python"],
		[".go", "go"],
		[".rs", "rust"],
		[".rb", "ruby"],
		[".c", "c"],
		[".cpp", "cpp"],
		[".cs", "csharp"],
		[".php", "php"],
		[".css", "css"],
	])("maps %s -> %s", (ext, lang) => {
		expect(resolveTreeSitterLanguage(`src/file${ext}`)).toBe(lang);
	});

	it("is case-insensitive on the extension", () => {
		expect(resolveTreeSitterLanguage("SRC/FILE.TS")).toBe("typescript");
	});

	it("returns undefined for unsupported extensions", () => {
		expect(resolveTreeSitterLanguage("file.md")).toBeUndefined();
		expect(resolveTreeSitterLanguage("file")).toBeUndefined();
	});
});

/**
 * #2467 review, F6: nothing shipped pinned the ONE thing
 * `isComplexitySupportedFile` exists to be — the client-free mirror of
 * `ComplexityClient.isSupportedFile` — or that `COMPLEXITY_LANGUAGE_IDS`
 * still names grammars the canonical registry actually resolves to. Either
 * one could drift silently: the client delegates back to this predicate
 * today, so a future edit that breaks that delegation compiles clean, and a
 * grammar rename in `language-registry.ts` would leave a `COMPLEXITY_LANGUAGE_IDS`
 * entry that `resolveTreeSitterLanguage` can never produce, silently starving
 * that language of complexity baselines.
 */
describe("isComplexitySupportedFile mirrors ComplexityClient.isSupportedFile (#2467 review, F6)", () => {
	// Direct positive/negative assertions, not a comparison against
	// `ComplexityClient.isSupportedFile` — that method PURELY delegates to
	// `isComplexitySupportedFile` (see `complexity-client.ts`), so comparing
	// the two is a tautology: gutting this predicate to `return false` makes
	// both sides agree on `false` for every extension and the test stays
	// green (caught in review round 1 of #2474's merge-with-master).
	it("returns true for an extension whose language complexity supports", () => {
		expect(isComplexitySupportedFile("src/file.ts")).toBe(true);
		expect(isComplexitySupportedFile("src/file.py")).toBe(true);
		expect(isComplexitySupportedFile("src/file.go")).toBe(true);
		expect(isComplexitySupportedFile("src/file.rs")).toBe(true);
	});

	it("returns false for an extension the registry resolves but complexity does not support", () => {
		// ".rb" resolves to a live grammar (see resolveTreeSitterLanguage above)
		// but "ruby" is not in COMPLEXITY_LANGUAGE_IDS.
		expect(isComplexitySupportedFile("src/file.rb")).toBe(false);
	});

	it("returns false for an extension the registry does not own at all", () => {
		expect(isComplexitySupportedFile("src/file.md")).toBe(false);
	});

	it("every COMPLEXITY_LANGUAGE_IDS entry is a live registry grammar id", () => {
		const liveGrammarIds = new Set(LANGUAGES.map((entry) => entry.grammar));
		for (const languageId of COMPLEXITY_LANGUAGE_IDS) {
			expect(liveGrammarIds.has(languageId)).toBe(true);
		}
	});
});

describe("shared TreeSitterClient singleton", () => {
	it("returns the same instance across calls (one client per process)", () => {
		const a = getSharedTreeSitterClient();
		const b = getSharedTreeSitterClient();
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it("poisons the singleton after a wasm abort (process-wide skip)", () => {
		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(getSharedTreeSitterClient()).not.toBeNull();

		markTreeSitterWasmAborted();

		expect(isTreeSitterWasmAborted()).toBe(true);
		// Every consumer now gets null and must skip tree-sitter work.
		expect(getSharedTreeSitterClient()).toBeNull();
		expect(getTreeSitterRuntimeStatus()).toMatchObject({
			available: false,
			wasmAborted: true,
			recovery: "restart_required",
			abortedAt: expect.any(String),
		});
	});

	it("reports healthy status before an abort", () => {
		expect(getTreeSitterRuntimeStatus()).toEqual({
			available: true,
			wasmAborted: false,
			recovery: "not_required",
		});
	});

	it("poisons every consumer when the parser reports an actual abort", async () => {
		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		const state = client as unknown as {
			parsers: Map<string, { parse: () => never }>;
		};
		const parse = vi.fn(() => {
			throw new Error("Aborted()");
		});
		state.parsers.set("typescript", { parse });

		await expect(
			client!.parseFile("virtual.ts", "typescript", "const x = 1;"),
		).resolves.toBeNull();
		expect(isTreeSitterWasmAborted()).toBe(true);
		expect(getSharedTreeSitterClient()).toBeNull();
		expect(client!.isAvailable()).toBe(false);
		await expect(
			client!.parseFile("again.ts", "typescript", "const y = 2;"),
		).resolves.toBeNull();
		expect(parse).toHaveBeenCalledTimes(1);
	});

	it("poisons the client when retired-tree deletion aborts", async () => {
		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		const firstTree = {
			rootNode: { type: "program" },
			delete: () => {
				throw new Error("abort()");
			},
		};
		const secondTree = { rootNode: { type: "program" }, delete: vi.fn() };
		const parse = vi
			.fn()
			.mockReturnValueOnce(firstTree)
			.mockReturnValueOnce(secondTree);
		const state = client as unknown as {
			parsers: Map<string, { parse: typeof parse }>;
		};
		state.parsers.set("typescript", { parse });

		await client!.parseFile("same.ts", "typescript", "const x = 1;");
		await client!.parseFile("same.ts", "typescript", "const x = 2;");
		for (let i = 0; i < 8; i++) await Promise.resolve();

		expect(isTreeSitterWasmAborted()).toBe(true);
		expect(getSharedTreeSitterClient()).toBeNull();
	});

	it("test reset restores a fresh, usable singleton", () => {
		markTreeSitterWasmAborted();
		expect(getSharedTreeSitterClient()).toBeNull();

		_resetSharedTreeSitterClientForTests();

		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(getSharedTreeSitterClient()).not.toBeNull();
	});
});

describe("shared tree cache is reused across consumers (one parse per write)", () => {
	it("re-parsing the same unchanged file returns the cached tree (no re-parse)", async () => {
		const env = setupTestEnvironment("pi-lens-tscache-");
		cleanups.push(env.cleanup);
		const file = createTempFile(
			env.tmpDir,
			"reuse.ts",
			"export const x = 1;\n",
		);

		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		expect(await client!.init()).toBe(true); // load grammar/wasm before parseFile

		const tree1 = await client!.parseFile(file, "typescript");
		expect(tree1).not.toBeNull();
		const tree2 = await client!.parseFile(file, "typescript");

		// A cache hit returns the SAME tree object — the file is parsed once and the
		// result served again, not re-parsed.
		expect(tree2).toBe(tree1);
	});

	it("two shared-client handles (e.g. runner + module-report) share one parse", async () => {
		const env = setupTestEnvironment("pi-lens-tscache-x-");
		cleanups.push(env.cleanup);
		const file = createTempFile(
			env.tmpDir,
			"shared.ts",
			"export function f() {}\n",
		);

		// Both subsystems obtain the SAME process-wide client → the SAME tree cache.
		const runnerClient = getSharedTreeSitterClient();
		const moduleReportClient = getSharedTreeSitterClient();
		expect(runnerClient).toBe(moduleReportClient);
		expect(await runnerClient!.init()).toBe(true);

		const parsedByRunner = await runnerClient!.parseFile(file, "typescript");
		expect(parsedByRunner).not.toBeNull();
		const servedToModuleReport = await moduleReportClient!.parseFile(
			file,
			"typescript",
		);

		// module-report is served the runner's cached tree — one parse, two consumers.
		expect(servedToModuleReport).toBe(parsedByRunner);
	});
});

describe("eviction frees WASM trees without corrupting live parsing (#417 regression)", () => {
	it("parses past the cache limit (real tree.delete() on eviction) and re-parses cleanly", async () => {
		const env = setupTestEnvironment("pi-lens-tsevict-");
		cleanups.push(env.cleanup);
		const client = getSharedTreeSitterClient();
		expect(client).not.toBeNull();
		expect(await client!.init()).toBe(true);

		// The shared TreeCache holds 50 entries. Parse 60 distinct files so the
		// earliest trees are evicted AND their WASM heap is freed via tree.delete()
		// mid-run. Fake-tree unit tests can't exercise a real double-free/UAF; this
		// drives real web-tree-sitter trees through eviction.
		const files: string[] = [];
		for (let i = 0; i < 60; i++) {
			files.push(
				createTempFile(env.tmpDir, `f${i}.ts`, `export const v${i} = ${i};\n`),
			);
		}

		const first = await client!.parseFile(files[0], "typescript");
		expect(first).not.toBeNull();
		expect(first!.rootNode.type).toBe("program");

		// Each just-parsed (newest) tree must stay valid — freeing evicted older
		// neighbours must not corrupt it. (We never touch `first` after this point;
		// it is the tree that gets evicted+freed — the documented transient-use rule.)
		for (const f of files) {
			const tree = await client!.parseFile(f, "typescript");
			expect(tree).not.toBeNull();
			expect(tree!.rootNode.type).toBe("program");
		}

		// Re-parsing the evicted-and-freed first file yields a fresh, usable tree —
		// no use-after-free, no crash.
		const reparsed = await client!.parseFile(files[0], "typescript");
		expect(reparsed).not.toBeNull();
		expect(reparsed!.rootNode.type).toBe("program");
		expect(client!.getParseCacheStats()).toMatchObject({
			lookups: 62,
			hits: 1,
			misses: 61,
			coldMisses: 60,
			capacityMisses: 1,
			sets: 61,
			evictions: 11,
			parserInvocations: 61,
			parserFailures: 0,
		});
	});
});
