import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGeneratedOrArtifact } from "../../clients/generated-artifacts.js";
import { TodoScanner } from "../../clients/todo-scanner.js";
import { removeTempDirSync } from "./test-utils.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-todo-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

describe("todo-scanner", () => {
	it("returns empty results when a file cannot be read", () => {
		const scanner = new TodoScanner();
		const dir = makeTempDir();

		expect(scanner.scanFile(dir)).toEqual([]);
	});

	it("skips files larger than the per-file size cap (#894 review)", () => {
		const scanner = new TodoScanner();
		const dir = makeTempDir();

		const big = path.join(dir, "huge.json");
		// > 512 KiB, with a TODO the scanner must never even read.
		fs.writeFileSync(big, `// TODO: buried\n${"x".repeat(600 * 1024)}\n`);
		expect(scanner.scanFile(big)).toEqual([]);

		const small = path.join(dir, "small.ts");
		fs.writeFileSync(small, "// TODO: visible\n");
		expect(scanner.scanFile(small)).toHaveLength(1);
	});

	it("does not treat markdown '# TODO' headings as work items (#894 review)", () => {
		const scanner = new TodoScanner();
		const dir = makeTempDir();

		const md = path.join(dir, "notes.md");
		fs.writeFileSync(
			md,
			"# TODO refactor plans\n\nprose here\n\n<!-- TODO: real annotation -->\n",
		);
		const items = scanner.scanFile(md);
		expect(items).toHaveLength(1);
		expect(items[0].message).toContain("real annotation");
	});
});

describe("lockfile exclusion (#894 review)", () => {
	it.each([
		"package-lock.json",
		"npm-shrinkwrap.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"Cargo.lock",
		"composer.lock",
		"Gemfile.lock",
		"poetry.lock",
		"uv.lock",
		"go.sum",
	])("classifies %s as a generated artifact", (name) => {
		expect(isGeneratedOrArtifact(path.join("proj", name))).toBe(true);
	});

	it("scanDirectory never surfaces TODOs from lockfiles", () => {
		const scanner = new TodoScanner();
		const dir = makeTempDir();

		// Content that WOULD match if the file were scanned at all.
		fs.writeFileSync(
			path.join(dir, "package-lock.json"),
			"// TODO: not a work item\n",
		);
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "# TODO: nope\n");
		fs.writeFileSync(path.join(dir, "app.ts"), "// TODO: real one\n");

		const result = scanner.scanDirectory(dir);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].file).toContain("app.ts");
	});
});
