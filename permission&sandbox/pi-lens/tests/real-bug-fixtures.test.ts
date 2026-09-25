import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface FixtureManifest {
	fixtures: Array<{
		language: string;
		file: string;
		classes: string[];
	}>;
}

const ROOT = path.resolve(process.cwd(), "tests", "fixtures", "real-bugs");

describe("real bug fixtures", () => {
	it("covers all target languages", () => {
		const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8");
		const manifest = JSON.parse(raw) as FixtureManifest;

		const langs = new Set(manifest.fixtures.map((f) => f.language));
		expect(langs).toEqual(
			new Set(["typescript", "python", "go", "rust", "ruby"]),
		);
	});

	it("fixture files exist and include declared bug class markers", () => {
		const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8");
		const manifest = JSON.parse(raw) as FixtureManifest;

		for (const fixture of manifest.fixtures) {
			const fullPath = path.join(ROOT, fixture.file);
			expect(fs.existsSync(fullPath)).toBe(true);

			const content = fs.readFileSync(fullPath, "utf-8");
			for (const cls of fixture.classes) {
				expect(content.includes(`BUG:${cls}`)).toBe(true);
			}
		}
	});
});
