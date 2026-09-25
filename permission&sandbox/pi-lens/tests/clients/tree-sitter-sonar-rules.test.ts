import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

function writeTempFile(contents: string): string {
	const env = setupTestEnvironment("pi-lens-sonar-ts-rules-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "sample.ts", contents);
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

describe("no-equality-in-for-condition (S888)", () => {
	it("flags == in a for-loop termination condition", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-equality-in-for-condition");
		const filePath = writeTempFile("for (let i = 0; i == n; i += 2) {}\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(1);
	});

	it("flags != in a for-loop termination condition", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-equality-in-for-condition");
		const filePath = writeTempFile("for (let i = 0; i != n; i++) {}\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(1);
	});

	it("does not flag relational operators", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-equality-in-for-condition");
		const filePath = writeTempFile("for (let i = 0; i < n; i++) {}\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(0);
	});

	it("does not flag strict equality (===/!==) which is a different operator", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-equality-in-for-condition");
		const filePath = writeTempFile("for (let i = 0; i !== n; i++) {}\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(0);
	});

	it("does not flag == used in the loop body, only the condition", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-equality-in-for-condition");
		const filePath = writeTempFile(
			"for (let i = 0; i < n; i++) { if (a == b) {} }\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(0);
	});
});

describe("no-jump-in-finally (S1143)", () => {
	it("flags a return statement in a finally block", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-jump-in-finally");
		const filePath = writeTempFile(
			"function f() { try { return 1; } finally { return 2; } }\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(1);
	});

	it("flags a throw statement in a finally block", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-jump-in-finally");
		const filePath = writeTempFile("try { work(); } finally { throw e; }\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(1);
	});

	it("does not flag a finally block with no control-flow jump", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-jump-in-finally");
		const filePath = writeTempFile("try { work(); } finally { cleanup(); }\n");
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(0);
	});

	it("does not flag a return inside a nested function in finally", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("no-jump-in-finally");
		const filePath = writeTempFile(
			"try { work(); } finally { arr.forEach((x) => { return x; }); }\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches).toHaveLength(0);
	});
});
