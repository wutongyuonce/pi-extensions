/**
 * #440 — per-rule `skip_test_files` carve-out. `python-assert-production` flags
 * `assert` (stripped by python -O), but `assert` is the idiomatic test assertion,
 * so firing in test files is pure noise. The tree-sitter runner otherwise runs on
 * test files, so the rule opts out via `skip_test_files`. Exercised through the
 * REAL runner (real client + real query loader) so the isTestFile filter is under
 * test, not mocked away.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";

// Keep unrelated fire-and-forget review-graph enrichment out of real-runner tests.
vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: () => ({ added: [], removed: [], modified: [] }),
	}),
);
import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

let env: RealRunnerEnv;
afterAll(() => env?.cleanup());

async function rulesFor(
	relPath: string,
	content: string,
): Promise<Set<string>> {
	const { ctx } = env.addFile(relPath, content);
	return firedRuleIds(await treeSitterRunner.run(ctx));
}

const ASSERT_SRC = "def f(x):\n    assert x > 0, 'x required'\n    return x\n";

describe("tree-sitter runner — skip_test_files (#440)", () => {
	beforeAll(async () => {
		env = makeRealRunnerEnv();
		await assertGrammarAvailable("python");
	});

	it("flags python-assert-production in a production file", async () => {
		expect(await rulesFor("app.py", ASSERT_SRC)).toContain(
			"python-assert-production",
		);
	}, 30_000);

	it("does NOT flag python-assert-production in a tests/ file", async () => {
		expect(
			await rulesFor(
				"tests/test_app.py",
				"def test_ok():\n    assert 1 + 1 == 2\n",
			),
		).not.toContain("python-assert-production");
	}, 30_000);
});
