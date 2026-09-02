import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
// The REAL config object, not its source text: a text scan would accept a
// commented-out entry (the comment-out evasion this guard exists to block).
// NOTE the explicit `.ts` — the usual `.js` spelling would resolve to the
// gitignored COMPILED `vitest.config.js` that `npm run build` emits at the repo
// root, so this guard would silently read a stale config (verified 2026-08-12:
// commenting an entry out of the .ts left the imported list unchanged).
import vitestConfig from "../../vitest.config.ts";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Deliberate exception, defined ONCE and used for both directions of the
// check below: these tests validate the sampler itself with synthetic
// busy-loop/yielding examples, rather than guarding a production timing budget.
const timingMeasurementOnly = ["tests/support/perf-harness.test.ts"];

// Self-exclusion: this meta-test must not match ITSELF. It searches for the
// very markers that define a timing-sensitive test, so the marker literals are
// split and re-joined at runtime — spelled out in full, this file would report
// itself as an unphased timing-sensitive test.
const samplerHelper = "measureMaxSyncBlock" + "Ms";
const cpuUsageCall = "process." + "cpuUsage(";

function testFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return testFiles(entryPath);
		return entry.name.endsWith(".test.ts") ? [entryPath] : [];
	});
}

/** The `include` list of the "timing-sensitive" project, read from the live config. */
function timingSensitiveInclude(): string[] {
	const projects: unknown = vitestConfig.test?.projects;
	if (!Array.isArray(projects)) {
		throw new Error(
			"vitest.config.ts default export has no test.projects array",
		);
	}
	const project = projects
		.map(
			(entry) =>
				(entry as { test?: { name?: unknown; include?: unknown } })?.test,
		)
		.find((test) => test?.name === "timing-sensitive");
	if (!project)
		throw new Error('vitest.config.ts has no project named "timing-sensitive"');
	const include = project.include;
	if (!Array.isArray(include) || include.length === 0) {
		throw new Error('the "timing-sensitive" project has no include list');
	}
	return include.map((entry) => toPosix(String(entry)));
}

/**
 * Detect by IMPORT/USAGE, not by assertion shape: a regex over the assertion
 * (`expect(<name>).…`, or a hardcoded `cpuMs` variable) is defeated by renaming
 * the variable or adding an expect message. A file counts as timing-sensitive
 * when it pulls the event-loop-occupancy sampler out of the perf harness, or
 * samples process CPU time directly.
 *
 * Out of scope on purpose: plain wall-clock `toBeLessThan` budgets. Those are
 * not measured by the sampler and are not what the timing-sensitive project's
 * quiet phase exists to protect; folding them in would sweep in most of the
 * suite for no contention benefit.
 */
function isTimingSensitive(source: string): boolean {
	const importsSampler = new RegExp(
		String.raw`import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\b${samplerHelper}\b[^}]*\}\s*from\s*["'][^"']*perf-harness[^"']*["']`,
	).test(source);
	return importsSampler || source.includes(cpuUsageCall);
}

describe("timing-sensitive Vitest project coverage", () => {
	it("phases every sync-block-sampler and process.cpuUsage budget test", () => {
		const included = timingSensitiveInclude();
		const timingFiles = testFiles(path.join(repoRoot, "tests"))
			.map((file) => toPosix(path.relative(repoRoot, file)))
			.filter((file) =>
				isTimingSensitive(fs.readFileSync(path.join(repoRoot, file), "utf8")),
			);
		// Calibration: 14 sampler/CPU-usage tests on 2026-08-26; half is 7.
		assertNonEmptyScan("timing-sensitive detection", timingFiles.length, 7);

		// Reverse check: a renamed or deleted test must not leave a dead glob
		// behind — a stale entry silently stops phasing anything at all.
		const dead = [...included, ...timingMeasurementOnly].filter(
			(file) => !fs.existsSync(path.join(repoRoot, file)),
		);
		expect(dead, "timing-sensitive include entries must exist on disk").toEqual(
			[],
		);

		const unexpected = timingFiles.filter(
			(file) =>
				!included.includes(file) && !timingMeasurementOnly.includes(file),
		);
		expect(
			unexpected,
			"sampler/cpuUsage tests must be in timingSensitiveInclude",
		).toEqual([]);

		const staleExceptions = timingMeasurementOnly.filter(
			(file) => !timingFiles.includes(file),
		);
		expect(
			staleExceptions,
			"escape-hatch entries must still be sampler/cpuUsage tests",
		).toEqual([]);
	});

	// #1920: the "wall-clock-budget" project's entries are likewise excluded
	// from the default project, so a renamed or deleted member would silently
	// stop running ANYWHERE (excluded from default, absent from its phase).
	// Existence-only check on purpose: membership is a curated budget list,
	// not derivable from an import marker.
	it("wall-clock-budget include entries exist on disk (#1920)", () => {
		const projects: unknown = vitestConfig.test?.projects;
		const project = (Array.isArray(projects) ? projects : [])
			.map(
				(entry) =>
					(entry as { test?: { name?: unknown; include?: unknown } })?.test,
			)
			.find((test) => test?.name === "wall-clock-budget");
		expect(
			project,
			'vitest.config.ts has no project named "wall-clock-budget"',
		).toBeTruthy();
		const include = project!.include;
		expect(
			Array.isArray(include) && include.length > 0,
			'"wall-clock-budget" has no include list',
		).toBe(true);
		const dead = (include as unknown[])
			.map((entry) => toPosix(String(entry)))
			.filter((file) => !fs.existsSync(path.join(repoRoot, file)));
		expect(dead, "wall-clock-budget entries must exist on disk").toEqual([]);
	});
});
