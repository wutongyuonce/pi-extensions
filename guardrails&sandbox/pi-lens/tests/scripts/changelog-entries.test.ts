import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEntry } from "../../scripts/rollup-changelog.mjs";

const entriesDir = path.resolve(process.cwd(), ".changelog");

describe("changelog entry guard", () => {
	it("validates every checked-in entry file", () => {
		const files = fs
			.readdirSync(entriesDir)
			.filter((name) => name.endsWith(".md") && name !== "README.md");
		for (const file of files)
			expect(() =>
				parseEntry(fs.readFileSync(path.join(entriesDir, file), "utf8"), file),
			).not.toThrow();
	});
});
