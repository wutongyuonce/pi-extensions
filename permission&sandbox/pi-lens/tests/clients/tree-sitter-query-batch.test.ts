/**
 * Batched rule execution (#675).
 *
 * A project scan ran one tree walk PER RULE — ~34 walks per file. `runQueriesOnFile`
 * compiles the rule set into a single multi-pattern query and walks once, so these
 * tests pin the two things that batching could plausibly break: the results must be
 * identical to the per-rule path, and each rule must keep its own post-filter,
 * metavars and result cap.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../clients/tree-sitter-shared.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	_resetSharedTreeSitterClientForTests();
});

const rule = (
	id: string,
	query: string,
	extra: Partial<TreeSitterQuery> = {},
): TreeSitterQuery =>
	({
		id,
		name: id,
		severity: "warning",
		language: "typescript",
		message: id,
		query,
		metavars: [],
		filePath: `rules/tree-sitter-queries/typescript/${id}.yml`,
		...extra,
	}) as TreeSitterQuery;

const SOURCE = `
function alpha(a, b) { console.log(a); return b; }
class Beta { method() { console.log("x"); } }
const gamma = (v) => console.log(v);
`;

const RULES = [
	rule("calls", "(call_expression) @CALL", { metavars: ["CALL"] }),
	rule("functions", "(function_declaration) @FN", { metavars: ["FN"] }),
	rule("classes", "(class_declaration) @CLS", { metavars: ["CLS"] }),
	rule("arrows", "(arrow_function) @ARROW", { metavars: ["ARROW"] }),
];

describe("runQueriesOnFile", () => {
	it("returns exactly what one-query-at-a-time returns, in rule order", async () => {
		const env = setupTestEnvironment("pi-lens-batch-eq-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "a.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const perRule: Array<{ id: string; line: number; text: string }> = [];
		for (const def of RULES) {
			for (const match of await client.runQueryOnFile(
				def,
				file,
				"typescript",
			)) {
				perRule.push({ id: def.id, line: match.line, text: match.matchedText });
			}
		}

		const batched = (
			await client.runQueriesOnFile(RULES, file, "typescript")
		).map(({ queryDef, match }) => ({
			id: queryDef.id,
			line: match.line,
			text: match.matchedText,
		}));

		expect(batched).toEqual(perRule);
		expect(batched.length).toBeGreaterThan(0);
	});

	it("applies maxResults per rule, not across the batch", async () => {
		const env = setupTestEnvironment("pi-lens-batch-cap-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "b.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const capped = await client.runQueriesOnFile(RULES, file, "typescript", {
			maxResults: 1,
		});
		const byRule = new Map<string, number>();
		for (const { queryDef } of capped) {
			byRule.set(queryDef.id, (byRule.get(queryDef.id) ?? 0) + 1);
		}
		for (const count of byRule.values()) expect(count).toBe(1);
		// More than one rule survives the cap — it is per rule, not global.
		expect(byRule.size).toBeGreaterThan(1);
	});

	it("rebuilds a batch query after cache eviction and still matches (#1397)", async () => {
		const previous = process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP;
		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "1";
		try {
			const env = setupTestEnvironment("pi-lens-batch-eviction-");
			cleanups.push(env.cleanup);
			const file = createTempFile(env.tmpDir, "evicted.ts", SOURCE);
			const client = getSharedTreeSitterClient()!;
			expect(await client.init()).toBe(true);
			const alternate = [rule("only-functions", "(function_declaration) @FN")];

			const first = await client.runQueriesOnFile(RULES, file, "typescript");
			expect(first.some(({ queryDef }) => queryDef.id === "calls")).toBe(true);
			await client.runQueriesOnFile(alternate, file, "typescript");
			// RULES was evicted and its Query was disposed; this call must compile a
			// fresh batch rather than use the deleted Query object.
			const rebuilt = await client.runQueriesOnFile(RULES, file, "typescript");
			expect(rebuilt.some(({ queryDef }) => queryDef.id === "calls")).toBe(
				true,
			);
			expect(rebuilt.length).toBe(first.length);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP;
			else process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = previous;
		}
	});

	it("drops a rule whose post_filter has no implementation", async () => {
		const env = setupTestEnvironment("pi-lens-batch-filter-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "c.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const ghost = rule("ghost-filter", "(call_expression) @CALL", {
			metavars: ["CALL"],
			post_filter: "definitely_not_implemented",
		});
		// Failing OPEN here is what made `duplicate-function-arg` report 59
		// phantom duplicates: the rule's own condition was never evaluated.
		expect(await client.runQueriesOnFile([ghost], file, "typescript")).toEqual(
			[],
		);
		expect(await client.runQueryOnFile(ghost, file, "typescript")).toEqual([]);
	});

	it("skips a rule that cannot compile without losing the rest of the batch", async () => {
		const env = setupTestEnvironment("pi-lens-batch-bad-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "d.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const broken = rule("broken", "(this_node_type_does_not_exist) @X", {
			metavars: ["X"],
		});
		const found = await client.runQueriesOnFile(
			[broken, ...RULES],
			file,
			"typescript",
		);
		expect(found.some(({ queryDef }) => queryDef.id === "broken")).toBe(false);
		expect(found.some(({ queryDef }) => queryDef.id === "calls")).toBe(true);
	});

	it("compiles and matches the repaired Go, Rust, and Kotlin rules (#884)", async () => {
		const env = setupTestEnvironment("pi-lens-884-rules-");
		cleanups.push(env.cleanup);
		const loader = new TreeSitterQueryLoader();
		const loaded = await loader.loadQueries(process.cwd());
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);
		const cases = [
			{
				id: "go-mutex-copy",
				language: "go",
				ext: "go",
				bad: "package p\nfunc f(mu sync.Mutex) { use(mu) }\n",
				good: "package p\nfunc f(mu *sync.Mutex) { use(mu) }\n",
			},
			{
				id: "go-shared-map-write-goroutine",
				language: "go",
				ext: "go",
				bad: "package p\nfunc f() { go func() { m[k] = v }() }\n",
				good: "package p\nfunc f() { m[k] = v }\n",
			},
			{
				id: "rust-lock-held-across-await",
				language: "rust",
				ext: "rs",
				bad: "async fn f(state: S) { let guard = state.lock().await; work().await; drop(guard); }\n",
				good: "async fn f(state: S) { { let guard = state.lock().await; use_guard(&guard); } work().await; }\n",
			},
			{
				id: "prepared-statement-indices",
				language: "kotlin",
				ext: "kt",
				bad: "fun f(stmt: S) { stmt.setString(0, value) }\n",
				good: "fun f(stmt: S) { stmt.setString(1, value) }\n",
			},
		] as const;

		for (const testCase of cases) {
			const query = [...loaded.values()]
				.flat()
				.find((candidate) => candidate.id === testCase.id);
			expect(query, testCase.id).toBeDefined();
			const badFile = createTempFile(
				env.tmpDir,
				`bad.${testCase.ext}`,
				testCase.bad,
			);
			const goodFile = createTempFile(
				env.tmpDir,
				`good.${testCase.ext}`,
				testCase.good,
			);
			expect(
				await client.runQueryOnFile(query!, badFile, testCase.language),
			).not.toEqual([]);
			expect(
				await client.runQueryOnFile(query!, goodFile, testCase.language),
			).toEqual([]);
		}
	});

	describe("batch cache after grammar-load failures (#889)", () => {
		it("retries the batch compile after a transient loadLanguage failure", async () => {
			const env = setupTestEnvironment("pi-lens-batch-retry-");
			cleanups.push(env.cleanup);
			const file = createTempFile(env.tmpDir, "retry.ts", SOURCE);
			const client = getSharedTreeSitterClient()!;
			expect(await client.init()).toBe(true);

			const state = client as unknown as {
				loadLanguage: (languageId: string) => Promise<unknown>;
				queryBatchCache: Map<string, unknown>;
			};
			const realLoadLanguage = state.loadLanguage.bind(client);
			let failNext = true;
			let loadCalls = 0;
			state.loadLanguage = async (languageId: string) => {
				loadCalls++;
				if (failNext) {
					failNext = false;
					// Transient: offline lazy grammar fetch, mid-scan load error.
					return null;
				}
				return realLoadLanguage(languageId);
			};

			// First scan: the batch compile can't load the grammar and must NOT
			// cache null — the per-rule fallback still produces results.
			const first = await client.runQueriesOnFile(RULES, file, "typescript");
			expect(first.length).toBeGreaterThan(0);
			expect(state.queryBatchCache.size).toBe(0);

			// Second scan: the load succeeds, so the batch is compiled, cached,
			// and returns byte-identical results.
			const second = await client.runQueriesOnFile(RULES, file, "typescript");
			expect(second).toEqual(first);
			expect(state.queryBatchCache.size).toBe(1);
			expect([...state.queryBatchCache.values()][0]).not.toBeNull();
			// The batch path retried the load instead of staying on the fallback.
			expect(loadCalls).toBeGreaterThanOrEqual(3);
		});

		it("bounds retries when the grammar never loads", async () => {
			const env = setupTestEnvironment("pi-lens-batch-bound-");
			cleanups.push(env.cleanup);
			const client = getSharedTreeSitterClient()!;
			expect(await client.init()).toBe(true);

			const state = client as unknown as {
				loadLanguage: (languageId: string) => Promise<unknown>;
				compileQueryBatch: (
					defs: TreeSitterQuery[],
					languageId: string,
				) => Promise<unknown>;
				queryBatchCache: Map<string, unknown>;
			};
			let loadCalls = 0;
			state.loadLanguage = async () => {
				loadCalls++;
				return null;
			};

			for (let i = 0; i < 5; i++) {
				expect(await state.compileQueryBatch(RULES, "typescript")).toBeNull();
			}
			// After QUERY_BATCH_MAX_LOAD_FAILURES (3) consecutive load failures the
			// miss is cached like any deterministic failure — no hot retry loop.
			expect(loadCalls).toBe(3);
			expect([...state.queryBatchCache.values()]).toEqual([null]);
		});

		it("caches a genuine compile failure permanently", async () => {
			const env = setupTestEnvironment("pi-lens-batch-perm-");
			cleanups.push(env.cleanup);
			const client = getSharedTreeSitterClient()!;
			expect(await client.init()).toBe(true);

			const state = client as unknown as {
				loadLanguage: (languageId: string) => Promise<unknown>;
				compileQueryBatch: (
					defs: TreeSitterQuery[],
					languageId: string,
				) => Promise<unknown>;
			};
			const broken = rule("broken-perm", "(node_that_does_not_exist) @X", {
				metavars: ["X"],
			});

			// A rule set that cannot compile against this grammar is a
			// deterministic failure — cached null on the first call.
			expect(await state.compileQueryBatch([broken], "typescript")).toBeNull();

			state.loadLanguage = async () => {
				throw new Error("loadLanguage must not be retried for a cached miss");
			};
			expect(await state.compileQueryBatch([broken], "typescript")).toBeNull();
		});
	});
});
