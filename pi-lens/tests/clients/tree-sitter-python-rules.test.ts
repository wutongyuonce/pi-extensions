import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

function writeTempFile(contents: string): string {
	const env = setupTestEnvironment("pi-lens-python-rules-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "sample.py", contents);
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

describe("python tree-sitter rules", () => {
	describe("python-empty-except (refs #884)", () => {
		it("flags an except block that only does 'pass'", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-empty-except");
			const filePath = writeTempFile(
				`try:\n    risky()\nexcept Exception:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag an except block that logs and re-raises", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-empty-except");
			const filePath = writeTempFile(
				`try:\n    risky()\nexcept Exception as e:\n    logger.error("Failed: %s", e)\n    raise\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("bare-except (refs #1031/#1244)", () => {
		it("flags a bare except", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("bare-except");
			const filePath = writeTempFile(`try:\n    risky()\nexcept:\n    pass\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag a named exception", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("bare-except");
			const filePath = writeTempFile(
				`try:\n    risky()\nexcept ValueError:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it("does not flag a subscripted generic exception spec (#1244)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("bare-except");
			const filePath = writeTempFile(
				`try:\n    risky()\nexcept dict[str, int]:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it("does not flag a subscripted PEP 654 exception group (#1244)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("bare-except");
			const filePath = writeTempFile(
				`try:\n    risky()\nexcept BaseExceptionGroup[TypeError, ValueError]:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it.each([
			["tuple", "except (ValueError, KeyError):"],
			["qualified", "except pkg.mod.Error:"],
			["alias", "except ValueError as error:"],
			["union", "except ValueError | TypeError:"],
			["subscript", "except cache[key]:"],
			["trailing comma", "except (ValueError,):"],
			["exception group", "except* ValueError:"],
		])("does not flag %s exception specs", async (_label, clause) => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("bare-except");
			const filePath = writeTempFile(
				`try:\n    risky()\n${clause}\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("in-operator-unsupported (refs #884)", () => {
		it("flags 'in' used against None", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("in-operator-unsupported");
			const filePath = writeTempFile(`x = 5\nif x in None:\n    pass\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("flags 'not in' used against None", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("in-operator-unsupported");
			const filePath = writeTempFile(`x = 5\nif x not in None:\n    pass\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag 'in' used against a list", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("in-operator-unsupported");
			const filePath = writeTempFile(
				`items = [1, 2, 3]\nif x in items:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it("does not flag 'in' used against a string, dict or set", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("in-operator-unsupported");
			const filePath = writeTempFile(
				`x = "a"\nd = {}\ns = {1, 2}\nif x in "abc":\n    pass\nif x in d:\n    pass\nif x in s:\n    pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("no-super-torchscript (refs #884)", () => {
		it("flags a super() call in a method of a @torch.jit.script class", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("no-super-torchscript");
			const filePath = writeTempFile(
				`@torch.jit.script\nclass MyModel(nn.Module):\n    def forward(self, x):\n        return super().forward(x)\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag super() in a class without the TorchScript decorator", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("no-super-torchscript");
			const filePath = writeTempFile(
				`class MyModel(nn.Module):\n    def forward(self, x):\n        return super().forward(x)\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it("does not flag an ordinary super() call elsewhere", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("no-super-torchscript");
			const filePath = writeTempFile(
				`class Foo(Bar):\n    def __init__(self):\n        super().__init__()\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("notimplemented-boolean-context (refs #884)", () => {
		it("flags NotImplemented used as an if-condition", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("notimplemented-boolean-context");
			const filePath = writeTempFile(`if NotImplemented:\n    pass\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("flags NotImplemented combined with 'and'", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("notimplemented-boolean-context");
			const filePath = writeTempFile(`result = NotImplemented and True\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("flags 'not NotImplemented'", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("notimplemented-boolean-context");
			const filePath = writeTempFile(`if not NotImplemented:\n    pass\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag NotImplemented returned from an operator method", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("notimplemented-boolean-context");
			const filePath = writeTempFile(
				`def __eq__(self, other):\n    if not isinstance(other, MyClass):\n        return NotImplemented\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("yield-return-outside-function (refs #884)", () => {
		it("flags a module-level yield", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("yield-return-outside-function");
			const filePath = writeTempFile(`yield 1\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("flags a module-level return", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("yield-return-outside-function");
			const filePath = writeTempFile(`return 42\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag yield/return inside a function", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("yield-return-outside-function");
			const filePath = writeTempFile(
				`def gen():\n    yield 1\n\ndef func():\n    return 42\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});

	describe("exit-signature-check (refs #884)", () => {
		it("flags __exit__ with only self", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("exit-signature-check");
			const filePath = writeTempFile(
				`class MyContext:\n    def __exit__(self):\n        pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("flags __exit__ missing exc_value and traceback", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("exit-signature-check");
			const filePath = writeTempFile(
				`class MyContext:\n    def __exit__(self, exc_type):\n        pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag __exit__ with the full signature", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("exit-signature-check");
			const filePath = writeTempFile(
				`class MyContext:\n    def __exit__(self, exc_type, exc_value, traceback):\n        pass\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it.each(["*args", "*exc_info", "exc_type, *rest", "**kw"])(
			"does not flag __exit__ whose splat absorbs the triple: (self, %s)",
			async (tail) => {
				// A splat accepts the whole (exc_type, exc_value, traceback) triple, so
				// counting named parameter children under-counts a valid signature.
				const client = getSharedTreeSitterClient()!;
				const query = await getQuery("exit-signature-check");
				const filePath = writeTempFile(
					`class MyContext:\n    def __exit__(self, ${tail}):\n        return False\n`,
				);

				const matches = await client.runQueryOnFile(query, filePath, "python");

				expect(matches).toHaveLength(0);
			},
		);
	});

	describe("return-in-generator", () => {
		it("flags valued return in a synchronous generator", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("return-in-generator");
			const filePath = writeTempFile(
				`def gen():\n    yield 1\n    return 42\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(1);
		});

		it("does not flag normal coroutine return values", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("return-in-generator");
			const filePath = writeTempFile(
				`async def get_details(request):\n    await load(request)\n    return TemplateResponse('page.html', {'request': request})\n`,
			);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});

		it("does not flag non-generator functions", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("return-in-generator");
			const filePath = writeTempFile(`def compute():\n    return 42\n`);

			const matches = await client.runQueryOnFile(query, filePath, "python");

			expect(matches).toHaveLength(0);
		});
	});
});
