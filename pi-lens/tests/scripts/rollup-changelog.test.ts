import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHANGELOG_SECTIONS,
	parseEntry,
	rollupChangelog,
} from "../../scripts/rollup-changelog.mjs";

const tempDirs: string[] = [];
afterEach(() =>
	tempDirs
		.splice(0)
		.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

function fixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-changelog-"));
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, ".changelog"));
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- old unreleased\n  continuation text\n  - nested detail\n\n### Security\n\n* existing security note.\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior\n",
	);
	return root;
}

describe("per-entry changelog rollup", () => {
	it("inserts the new version below Unreleased", () => {
		const root = fixtureRoot();
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(output.indexOf("## [Unreleased]")).toBeLessThan(
			output.indexOf("## [2.0.0] - 2026-08-13"),
		);
		expect(output).not.toContain("### Security\n\n\n## [2.0.0]");
	});

	it("promotes existing Unreleased content into the new version", () => {
		const root = fixtureRoot();
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		const released = output.slice(output.indexOf("## [2.0.0]"));
		expect(released).toContain(
			"- old unreleased\n  continuation text\n  - nested detail",
		);
		expect(released).toContain("* existing security note.");
	});

	it("places the version below Unreleased, folds its content, preserves multiline entries, and deletes files", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "b.md"),
			"---\nsection: Fixed\n---\n\n* **B.** fixed.\n  Hard-wrapped continuation.\n  - nested consequence\n",
		);
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			"---\nsection: Deprecated\n---\n\n- Plain deprecated entry without bold\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(output.indexOf("## [Unreleased]")).toBeLessThan(
			output.indexOf("## [2.0.0] - 2026-08-13"),
		);
		expect(output).toContain(
			"### Added\n\n- old unreleased\n  continuation text\n  - nested detail",
		);
		expect(output).toContain(
			"### Deprecated\n\n- Plain deprecated entry without bold",
		);
		expect(output).toContain(
			"### Fixed\n\n* **B.** fixed.\n  Hard-wrapped continuation.\n  - nested consequence",
		);
		expect(output).toContain("### Security\n\n* existing security note.");
		expect(fs.readdirSync(path.join(root, ".changelog"))).toEqual([]);
	});

	it("merges idempotently when the version heading already exists", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			"---\nsection: Changed\n---\n\n- **A** — changed\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const once = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(() =>
			rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" }),
		).not.toThrow();
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(once);
		expect(once.match(/^## \[2\.0\.0\]/gm)).toHaveLength(1);
	});

	it("reports malformed entries clearly without changing the changelog", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "bad.md"),
			"---\nsection: Nope\n---\n\n- bad\n",
		);
		expect(() => rollupChangelog("2.0.0", { rootDir: root })).toThrow(
			/bad\.md: section must be/,
		);
		expect(
			fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
		).not.toContain("2.0.0");
	});

	it.each([
		["wrapped-title.md", /wrapped-title/],
		["orphan-bullet.md", /orphan/],
	])("rejects the real-bug guard fixture %s", (file, problem) => {
		const fixture = path.resolve("tests/fixtures/changelog-entries", file);
		expect(() => parseEntry(fs.readFileSync(fixture, "utf8"), file)).toThrow(
			problem,
		);
	});

	it.each([
		["Added", "- **Bold** — em dash"],
		["Changed", "* **Bold.** period style"],
		["Deprecated", "- plain entry"],
		["Removed", "* plain star entry."],
		["Fixed", "- **Bold** plain separator"],
		["Security", "- security fix"],
	])("accepts %s entries in repository styles", (section, entry) => {
		expect(parseEntry(`---\nsection: ${section}\n---\n\n${entry}`)).toEqual({
			section,
			entry,
		});
	});

	it("covers the full Keep a Changelog section order", () => {
		expect(CHANGELOG_SECTIONS).toEqual([
			"Added",
			"Changed",
			"Deprecated",
			"Removed",
			"Fixed",
			"Security",
		]);
	});
});
