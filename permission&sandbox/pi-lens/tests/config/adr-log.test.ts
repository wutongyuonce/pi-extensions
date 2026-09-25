import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const ADR_DIR =
	process.env.PI_LENS_ADR_ROOT ?? path.join(REPO_ROOT, "docs/adr");

/**
 * Recurrence prevented: #3260's ADR log could gain an unnumbered, incomplete,
 * or missing record while AGENTS.md points at a path that does not exist.
 * This reads the real docs directory and AGENTS.md, rather than a copied list.
 */
describe("ADR log governance (#3260)", () => {
	it("keeps numbered ADRs contiguous and complete", () => {
		const files = fs
			.readdirSync(ADR_DIR)
			.filter((name) => /^0.*\.md$/.test(name))
			.sort();
		const numbers = files.map((name) => Number(name.slice(0, 4)));
		expect(numbers).toEqual(numbers.map((_, index) => index + 1));
		for (const name of files) {
			const text = fs.readFileSync(path.join(ADR_DIR, name), "utf8");
			for (const heading of [
				"## Context",
				"## Decision",
				"## Consequences",
				"## Status",
			]) {
				expect(text, `${name} is missing ${heading}`).toContain(heading);
			}
		}
	});

	it("keeps every AGENTS.md ADR pointer resolvable", () => {
		const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
		const references = [...agents.matchAll(/docs\/adr\/0[^\s)`]+\.md/g)].map(
			(match) => match[0],
		);
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			expect(
				fs.existsSync(path.join(REPO_ROOT, reference)),
				`missing ADR referenced from AGENTS.md: ${reference}`,
			).toBe(true);
		}
	});
});
