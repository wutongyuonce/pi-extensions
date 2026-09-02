import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// These rules (#884) were originally authored against JavaScript grammar node
// names (`call_expression`, `method_call`, `command`, `interpolated_string`)
// that do not exist in tree-sitter-ruby, so they never compiled and never
// produced a finding. Each case below pins the rewritten query to the REAL
// ruby grammar: it must flag the vulnerable form and leave the safe form alone.

const cleanups: Array<() => void> = [];

function writeTempFile(contents: string): string {
	const env = setupTestEnvironment("pi-lens-ruby-rules-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "sample.rb", contents);
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

async function run(id: string, source: string) {
	const client = getSharedTreeSitterClient()!;
	const query = await getQuery(id);
	const filePath = writeTempFile(source);
	return client.runQueryOnFile(query, filePath, "ruby");
}

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

describe("ruby security tree-sitter rules (#884)", () => {
	describe("ruby-command-injection", () => {
		it("flags a shell exec sink with interpolated input", async () => {
			expect(
				await run(
					"ruby-command-injection",
					`system("sh -c #{params[:cmd]}")\n`,
				),
			).toHaveLength(1);
		});

		it("flags a namespaced Open3 exec sink", async () => {
			expect(
				await run("ruby-command-injection", `Open3.capture3(cmd)\n`),
			).toHaveLength(1);
		});

		it("does not flag a non-exec method call", async () => {
			expect(
				await run("ruby-command-injection", `File.read(path)\n`),
			).toHaveLength(0);
		});
	});

	describe("ruby-eval", () => {
		it("flags eval with a variable argument", async () => {
			expect(await run("ruby-eval", `eval(user_input)\n`)).toHaveLength(1);
		});

		it("does not flag const_get / send alternatives", async () => {
			expect(
				await run("ruby-eval", `Object.const_get(class_name)\n`),
			).toHaveLength(0);
		});
	});

	describe("ruby-insecure-deserialization", () => {
		it("flags Marshal.load", async () => {
			expect(
				await run("ruby-insecure-deserialization", `Marshal.load(payload)\n`),
			).toHaveLength(1);
		});

		it("flags YAML.unsafe_load", async () => {
			expect(
				await run("ruby-insecure-deserialization", `YAML.unsafe_load(data)\n`),
			).toHaveLength(1);
		});

		it("does not flag YAML.safe_load", async () => {
			expect(
				await run("ruby-insecure-deserialization", `YAML.safe_load(data)\n`),
			).toHaveLength(0);
		});
	});

	describe("ruby-insecure-random", () => {
		it("flags rand() used for a token", async () => {
			expect(
				await run("ruby-insecure-random", `token = rand(10_000_000)\n`),
			).toHaveLength(1);
		});

		it("does not flag SecureRandom", async () => {
			expect(
				await run("ruby-insecure-random", `token = SecureRandom.hex(16)\n`),
			).toHaveLength(0);
		});
	});

	describe("ruby-open-struct", () => {
		it("flags OpenStruct.new", async () => {
			expect(
				await run("ruby-open-struct", `person = OpenStruct.new(name: "Ada")\n`),
			).toHaveLength(1);
		});

		it("does not flag Struct.new", async () => {
			expect(
				await run("ruby-open-struct", `Person = Struct.new(:name, :age)\n`),
			).toHaveLength(0);
		});
	});

	describe("ruby-string-eval", () => {
		it("flags class_eval with a string argument", async () => {
			expect(
				await run("ruby-string-eval", `User.class_eval("def x; @x; end")\n`),
			).toHaveLength(1);
		});

		it("does not flag the block form of class_eval", async () => {
			expect(
				await run(
					"ruby-string-eval",
					`User.class_eval do\n  define_method(:x) { 1 }\nend\n`,
				),
			).toHaveLength(0);
		});
	});

	describe("ruby-weak-hash", () => {
		it("flags Digest::MD5.hexdigest", async () => {
			expect(
				await run("ruby-weak-hash", `Digest::MD5.hexdigest(data)\n`),
			).toHaveLength(1);
		});

		it("does not flag Digest::SHA256.hexdigest", async () => {
			expect(
				await run("ruby-weak-hash", `Digest::SHA256.hexdigest(data)\n`),
			).toHaveLength(0);
		});
	});
});
