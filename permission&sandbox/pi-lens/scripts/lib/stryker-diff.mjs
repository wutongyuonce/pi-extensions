import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const IMPORT_SPECIFIER_RE =
	/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/g;

export const DEFAULT_MAX_FILES = 6;

/**
 * Wall-clock bound the driver puts on the Stryker child, in minutes. It must
 * stay strictly below .github/workflows/mutation.yml's `timeout-minutes`, or
 * the runner cancels the job first and the driver never gets to say that it
 * evaluated nothing (advisory run 36098718085). The margin also covers
 * `npm ci`, `npm run build`, Stryker's in-place sandbox restore on SIGTERM,
 * and the report upload.
 */
export const MUTATION_BUDGET_MINUTES = 60;

// `git diff --unified=0` headers. Only the "+" side is used: it numbers lines
// in HEAD, which is the tree Stryker mutates in place.
const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export const isScriptMutationFile = (file) =>
	/^scripts\/.*\.mjs$/.test(file) && !file.endsWith(".test.mjs");

function collectTestFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function extractRelativeSpecifiers(content) {
	const specifiers = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match = IMPORT_SPECIFIER_RE.exec(content);
	while (match) {
		if (match[1].startsWith(".")) specifiers.push(match[1]);
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return specifiers;
}

function normalized(file) {
	return path
		.resolve(file)
		.replace(/\\/g, "/")
		.replace(/\.(?:mjs|js|cjs)$/, "");
}

export function capMutationFiles(files, maxFiles = DEFAULT_MAX_FILES) {
	if (!Number.isInteger(maxFiles) || maxFiles < 0) {
		throw new RangeError("maxFiles must be a non-negative integer");
	}
	const ordered = [...files].sort();
	return {
		selected: ordered.slice(0, maxFiles),
		skipped: ordered.slice(maxFiles),
	};
}

/**
 * Group the new-side changed line ranges of a `git diff --unified=0` payload by
 * file. An omitted hunk count means one line; a deletion-only hunk ("+c,0", and
 * "+0,0" at the top of a file) collapses to the single line at the deletion
 * point, because Stryker rejects an inverted or sub-line-1 mutation range during
 * options validation.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseChangedLineRanges(diffText) {
	const ranges = new Map();
	// git always emits the "+++ b/<path>" header before that file's hunks, so
	// `file` is set by the time a hunk header matches.
	let file;
	for (const line of diffText.split("\n")) {
		const fileMatch = DIFF_FILE_RE.exec(line);
		if (fileMatch) {
			file = fileMatch[1];
			ranges.set(file, []);
			continue;
		}
		const hunk = HUNK_HEADER_RE.exec(line);
		if (!hunk) continue;
		const newStart = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		const start = Math.max(1, newStart);
		ranges.get(file).push([start, Math.max(start, newStart + count - 1)]);
	}
	return ranges;
}

/**
 * Turn the selected files and their changed ranges into Stryker `--mutate`
 * patterns. A bare path means "mutate the whole file", which is the 2220-mutant
 * population that made the lane evaluate nothing, so a file with no changed
 * ranges contributes no pattern at all.
 *
 * @param {string[]} files
 * @param {Map<string, Array<[number, number]>>} rangesByFile
 * @returns {string[]}
 */
export function mutationRangePatterns(files, rangesByFile) {
	return files.flatMap((file) =>
		(rangesByFile.get(file) ?? []).map(
			([start, end]) => `${file}:${start}-${end}`,
		),
	);
}

/**
 * Describe a Stryker child that produced no mutation result. `spawnSync` marks
 * an expired budget with `error.code === "ETIMEDOUT"`; `signal` is null when the
 * child exits on the signal itself, which Stryker's UnexpectedExitHandler does,
 * so the signal is not a usable discriminator.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error & {code?: string}}} result
 * @param {number} budgetMinutes
 */
export function describeStrykerFailure(result, budgetMinutes) {
	const cause =
		result.error?.code === "ETIMEDOUT"
			? `the ${budgetMinutes}-minute mutation budget expired before Stryker produced a result`
			: `dry run or mutation execution failed (Stryker status ${result.status ?? "unknown"}${result.error ? `: ${result.error.message}` : ""})`;
	return `mutation diff: no mutants evaluated; ${cause}`;
}

export function formatCapNotice(selectedCount, totalCount, skipped) {
	return `capped: ${selectedCount} of ${totalCount} changed scripts mutated; skipped: ${skipped.join(", ")}`;
}

/**
 * Select tests that cover changed scripts through one-hop relative imports or
 * the conventional tests/scripts/<name>.test.ts sibling.
 *
 * @param {string[]} changedFiles
 * @param {{ testFiles?: string[], readFile?: (file: string) => string }} [options]
 */
export function mapRelatedTests(
	changedFiles,
	{
		testFiles = collectTestFiles("tests"),
		readFile = (file) => readFileSync(file, "utf8"),
	} = {},
) {
	const scripts = changedFiles.filter(isScriptMutationFile);
	const related = new Map(scripts.map((file) => [file, new Set()]));
	const testContents = testFiles.map((test) => {
		try {
			return [test, readFile(test)];
		} catch {
			return [test, null];
		}
	});

	for (const file of scripts) {
		const sibling = `tests/scripts/${path.basename(file, ".mjs")}.test.ts`;
		if (testFiles.some((test) => normalized(test) === normalized(sibling))) {
			related.get(file).add(sibling);
		}
		const target = normalized(file);
		for (const [test, content] of testContents) {
			if (content === null) continue;
			for (const specifier of extractRelativeSpecifiers(content)) {
				const imported = normalized(
					path.resolve(path.dirname(test), specifier),
				);
				if (imported === target) related.get(file).add(test);
			}
		}
	}

	return {
		related,
		covered: scripts.filter((file) => related.get(file).size > 0),
		uncovered: scripts.filter((file) => related.get(file).size === 0),
		tests: [...new Set([...related.values()].flatMap((files) => [...files]))],
	};
}
