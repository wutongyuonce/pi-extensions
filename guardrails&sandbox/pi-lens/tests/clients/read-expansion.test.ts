import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXPANSION_LIMIT_LINES,
	tryExpandRead,
} from "../../clients/read-expansion.js";
import { setupTestEnvironment } from "./test-utils.js";

function node(
	type: string,
	startRow: number,
	endRow: number,
	children: any[] = [],
	text = type,
) {
	return {
		type,
		text,
		children,
		startPosition: { row: startRow, column: 0 },
		endPosition: { row: endRow, column: 0 },
		parent: null as any,
	};
}

/**
 * Build a mock node tree with parent references wired up.
 * Required for ancestry chain tests since buildAncestryChain walks node.parent.
 */
function nodeTree(
	type: string,
	startRow: number,
	endRow: number,
	children: ReturnType<typeof node>[] = [],
	text = type,
): ReturnType<typeof node> {
	const n = node(type, startRow, endRow, children, text);
	for (const child of children) {
		child.parent = n;
		wireParents(child);
	}
	return n;
}

function wireParents(n: any): void {
	for (const child of n.children ?? []) {
		child.parent = n;
		wireParents(child);
	}
}

/**
 * Stand-in for the shared client. Expansion resolves its enclosing node INSIDE
 * `withParsedTree`'s callback (#417), so the stub runs `consume` on the mock tree.
 */
function stubClient(tree: unknown) {
	return {
		init: async () => true,
		withParsedTree: async (
			_filePath: string,
			_languageId: string,
			_content: string | undefined,
			consume: (tree: any) => unknown,
		) => ({ parsed: true as const, value: consume(tree) }),
	};
}

function unusedClient(reason: string) {
	return {
		init: async () => {
			throw new Error(reason);
		},
		withParsedTree: async () => {
			throw new Error(reason);
		},
	};
}

describe("EXPANSION_LIMIT_LINES", () => {
	it("is 100", () => {
		expect(EXPANSION_LIMIT_LINES).toBe(100);
	});

	it("expansion fires for reads at the limit (100 lines)", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-limit-");
		try {
			const lines =
				Array.from({ length: 110 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, lines);
			const tree = {
				rootNode: node("program", 0, 109, [
					node("function_declaration", 0, 109, [
						node("identifier", 0, 0, [], "bigFn"),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			// Request exactly EXPANSION_LIMIT_LINES — should expand
			const result = await tryExpandRead(
				filePath,
				50,
				100,
				110,
				tsClient as any,
			);
			expect(result).toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	it("expansion does not fire for reads above the limit (101 lines)", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-over-");
		try {
			const lines =
				Array.from({ length: 110 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, lines);
			const tsClient = unusedClient("should not be called");
			const result = await tryExpandRead(
				filePath,
				1,
				101,
				110,
				tsClient as any,
			);
			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("tryExpandRead", () => {
	it("expands when the requested offset is inside a symbol", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 1, 4, [
						node("identifier", 1, 1, [], "demo"),
					]),
				]),
			};
			const tsClient = stubClient(tree);

			const result = await tryExpandRead(filePath, 3, 1, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 2,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});

	it("expands overlapping reads without dropping originally requested lines", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-overlap-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 2, 4, [
						node("identifier", 2, 2, [], "demo"),
					]),
				]),
			};
			const tsClient = stubClient(tree);

			const result = await tryExpandRead(filePath, 2, 2, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 3,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});

	it("ancestry is undefined when enclosing symbol has no matching ancestors", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-noancestry-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			// function_declaration is at root — no enclosing parent of the same types
			const tree = {
				rootNode: nodeTree("program", 0, 5, [
					nodeTree("function_declaration", 1, 4, [
						node("identifier", 1, 1, [], "topLevel"),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			const result = await tryExpandRead(filePath, 3, 1, 6, tsClient as any);
			expect(result).toBeDefined();
			expect(result?.ancestry).toBeUndefined();
			expect(result?.enclosingSymbol.name).toBe("topLevel");
		} finally {
			env.cleanup();
		}
	});

	it("ancestry is populated outermost-first when method is inside a class", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-ancestry-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
			);
			// class_declaration (0-11) > method_definition (2-9) > arrow inner read at row 5
			const tree = {
				rootNode: nodeTree("program", 0, 11, [
					nodeTree("class_declaration", 0, 11, [
						node("identifier", 0, 0, [], "MyClass"),
						nodeTree("method_definition", 2, 9, [
							node("identifier", 2, 2, [], "myMethod"),
						]),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			const result = await tryExpandRead(filePath, 6, 1, 12, tsClient as any);
			expect(result).toBeDefined();
			expect(result?.enclosingSymbol.name).toBe("myMethod");
			expect(result?.enclosingSymbol.kind).toBe("method_definition");
			// class_declaration is the outer ancestor
			expect(result?.ancestry).toHaveLength(1);
			expect(result?.ancestry?.[0]).toMatchObject({
				name: "MyClass",
				kind: "class_declaration",
			});
		} finally {
			env.cleanup();
		}
	});

	it("expands markdown reads to the enclosing section", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-md-");
		try {
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(
				filePath,
				"# Title\nline2\nline3\n## Section A\nline5\nline6\n## Section B\nline8\n",
			);
			const tsClient = unusedClient("should not be called for markdown");

			// Read inside Section A (line 5), should expand to lines 4-6
			const result = await tryExpandRead(filePath, 5, 1, 8, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 4,
				newLimit: 3,
				enclosingSymbol: {
					name: "Section A",
					kind: "markdown_section",
					startLine: 4,
					endLine: 6,
				},
			});

			// Read already covers the whole section — no expansion
			const noExpand = await tryExpandRead(filePath, 4, 3, 8, tsClient as any);
			expect(noExpand).toBeUndefined();

			// Read inside top-level heading — expands to the whole top-level section
			const topResult = await tryExpandRead(filePath, 2, 1, 8, tsClient as any);
			expect(topResult).toMatchObject({
				newOffset: 1,
				newLimit: 8,
				enclosingSymbol: {
					name: "Title",
					kind: "markdown_section",
					startLine: 1,
					endLine: 8,
				},
			});
		} finally {
			env.cleanup();
		}
	});
});
