import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	EMPTY_UNRELEASED,
	extractSection,
	lintSectionBody,
} from "./lib/changelog.mjs";

export const CHANGELOG_SECTIONS = [
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
];

export function isEntryBullet(line) {
	return /^[-*]\s+\S/.test(line);
}

function fail(file, message) {
	throw new Error(`Invalid changelog entry ${file}: ${message}`);
}

export function parseEntry(text, file = "entry") {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0] !== "---") fail(file, "expected YAML front matter");
	const end = lines.indexOf("---", 1);
	if (end < 0) fail(file, "front matter is not closed");
	const marker = lines
		.slice(1, end)
		.find((line) => /^section:\s*\S+\s*$/.test(line));
	if (!marker) fail(file, "missing section marker");
	const section = marker.replace(/^section:\s*/, "");
	if (!CHANGELOG_SECTIONS.includes(section)) {
		fail(file, `section must be one of ${CHANGELOG_SECTIONS.join(", ")}`);
	}
	const body = lines
		.slice(end + 1)
		.join("\n")
		.trim();
	const topLevelEntries = body.split(/\r?\n/).filter(isEntryBullet);
	if (topLevelEntries.length !== 1) {
		fail(
			file,
			`expected exactly one top-level entry, found ${topLevelEntries.length}; column-0 Markdown bullets inside fenced examples also count, so indent example content`,
		);
	}
	if ((body.match(/```/g) ?? []).length % 2 !== 0) {
		fail(file, "unclosed Markdown code fence");
	}
	const hasExplicitHeading = /^#{2,4}\s/m.test(body);
	const problems = lintSectionBody(body).filter(
		(problem) => hasExplicitHeading || problem.kind !== "orphan",
	);
	for (const problem of problems) {
		const hint =
			problem.kind === "orphan"
				? "move the entry below its first Markdown heading"
				: "keep the complete bold entry title on one physical line";
		fail(file, `${problem.kind} at body line ${problem.line}: ${hint}`);
	}
	return { section, entry: body };
}

function readEntries(entriesDir) {
	if (!fs.existsSync(entriesDir)) return [];
	return fs
		.readdirSync(entriesDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".md") &&
				entry.name !== "README.md",
		)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ name }) => {
			const file = path.join(entriesDir, name);
			return { file, ...parseEntry(fs.readFileSync(file, "utf8"), name) };
		});
}

export function validateChangelogEntries({
	rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
	return readEntries(path.join(rootDir, ".changelog"));
}

function bucketSectionBody(body) {
	const buckets = new Map(CHANGELOG_SECTIONS.map((section) => [section, []]));
	if (!body) return buckets;
	let section;
	let lines = [];
	const flush = () => {
		const content = lines.join("\n").trim();
		if (section && content) buckets.get(section).push(content);
		lines = [];
	};
	for (const line of body.split(/\r?\n/)) {
		const heading = line.match(/^###\s+(.+?)\s*$/);
		if (heading) {
			flush();
			section = CHANGELOG_SECTIONS.find(
				(candidate) => candidate === heading[1],
			);
		} else if (section) {
			lines.push(line);
		}
	}
	flush();
	return buckets;
}

function renderBody(...bodies) {
	const combined = new Map(CHANGELOG_SECTIONS.map((section) => [section, []]));
	for (const body of bodies) {
		const buckets = bucketSectionBody(body);
		for (const section of CHANGELOG_SECTIONS)
			combined.get(section).push(...buckets.get(section));
	}
	return CHANGELOG_SECTIONS.map((section) => {
		const content = combined.get(section).filter(Boolean);
		return content.length ? `### ${section}\n\n${content.join("\n\n")}` : "";
	})
		.filter(Boolean)
		.join("\n\n");
}

export function rollupChangelog(
	version,
	{
		rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
		date = new Date().toISOString().slice(0, 10),
	} = {},
) {
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`Invalid version "${version}"; expected X.Y.Z`);
	const changelogPath = path.join(rootDir, "CHANGELOG.md");
	const entriesDir = path.join(rootDir, ".changelog");
	const entries = readEntries(entriesDir);
	const changelog = fs.readFileSync(changelogPath, "utf8");
	const unreleasedBody = extractSection(changelog, "Unreleased");
	if (unreleasedBody === null)
		throw new Error("CHANGELOG is missing the [Unreleased] heading");
	const existingBody = extractSection(changelog, version);
	if (
		entries.length === 0 &&
		existingBody !== null &&
		!/^\s*[-*]\s/m.test(unreleasedBody)
	) {
		return { version, files: [], changelogPath };
	}

	const entryBody = renderBody(
		...CHANGELOG_SECTIONS.map((section) => {
			const content = entries
				.filter((entry) => entry.section === section)
				.map((entry) => entry.entry);
			return content.length ? `### ${section}\n\n${content.join("\n\n")}` : "";
		}),
	);
	const releasedBody = renderBody(existingBody, unreleasedBody, entryBody);
	if (!releasedBody)
		throw new Error("No Unreleased or per-entry changelog content to release.");

	const unreleasedHeading = /^## \[Unreleased\][^\n]*$/m;
	const unreleasedStart = changelog.search(unreleasedHeading);
	const afterUnreleased = changelog.slice(unreleasedStart).search(/\n## \[/);
	const unreleasedEnd =
		afterUnreleased < 0
			? changelog.length
			: unreleasedStart + afterUnreleased + 1;
	let remainder = changelog.slice(unreleasedEnd);
	if (existingBody !== null) {
		const versionHeading = new RegExp(
			`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\n]*$`,
			"m",
		);
		const versionStart = remainder.search(versionHeading);
		if (versionStart >= 0) {
			const afterVersion = remainder.slice(versionStart).search(/\n## \[/);
			const versionEnd =
				afterVersion < 0 ? remainder.length : versionStart + afterVersion + 1;
			remainder =
				remainder.slice(0, versionStart) + remainder.slice(versionEnd);
		}
	}
	const prefix = changelog.slice(0, unreleasedStart);
	const next = `${prefix}${EMPTY_UNRELEASED}\n\n## [${version}] - ${date}\n\n${releasedBody}\n\n${remainder.replace(/^\s+/, "")}`;
	fs.writeFileSync(changelogPath, next.replace(/\s*$/, "\n"), "utf8");
	for (const entry of entries) fs.unlinkSync(entry.file);
	return { version, files: entries.map(({ file }) => file), changelogPath };
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const version = process.argv[2];
	if (version === "--check") {
		try {
			const entries = validateChangelogEntries();
			console.log(
				`Validated ${entries.length} changelog entr${entries.length === 1 ? "y" : "ies"}.`,
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	} else if (!version) {
		console.error("Usage: node scripts/rollup-changelog.mjs <version>|--check");
		process.exitCode = 1;
	} else {
		try {
			const result = rollupChangelog(version);
			console.log(
				`Rolled up ${result.files.length} changelog entr${result.files.length === 1 ? "y" : "ies"} for ${version}.`,
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	}
}
