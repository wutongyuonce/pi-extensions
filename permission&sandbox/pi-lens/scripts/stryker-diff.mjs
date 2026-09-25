import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import {
	capMutationFiles,
	DEFAULT_MAX_FILES,
	describeStrykerFailure,
	formatCapNotice,
	isScriptMutationFile,
	mapRelatedTests,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
} from "./lib/stryker-diff.mjs";

// The PR-body corpus is deliberately real and its cold scan is slower under
// Stryker instrumentation than in the ordinary suite. Keep this budget local
// to the mutation command so the normal test contract remains unchanged.
const MUTATION_TEST_TIMEOUT_MS = 30_000;

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const base = argumentValue("--base", "origin/master");
const maxFiles = Number(argumentValue("--max-files", DEFAULT_MAX_FILES));
const budgetMinutes = Number(
	argumentValue("--budget-minutes", MUTATION_BUDGET_MINUTES),
);
const budgetMs = Math.round(budgetMinutes * 60_000);

function changedScriptFiles() {
	try {
		return execFileSync(
			"git",
			["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.filter(isScriptMutationFile);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${base}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function changedLineRanges(files) {
	try {
		return parseChangedLineRanges(
			execFileSync(
				"git",
				[
					"diff",
					"--unified=0",
					"--diff-filter=AM",
					`${base}...HEAD`,
					"--",
					...files,
				],
				{ encoding: "utf8" },
			),
		);
	} catch (error) {
		console.error(
			`mutation diff: could not read changed lines of ${base}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeRunConfig(testFiles) {
	mkdirSync(".stryker", { recursive: true });
	const command = [
		"node_modules/.bin/vitest",
		"run",
		"--configLoader",
		"runner",
		"--testTimeout",
		String(MUTATION_TEST_TIMEOUT_MS),
		...testFiles.map(shellQuote),
	].join(" ");
	const config = `import base from "../stryker.config.mjs";\nexport default { ...base, commandRunner: { ...base.commandRunner, command: ${JSON.stringify(command)} } };\n`;
	const file = ".stryker/diff.config.mjs";
	writeFileSync(file, config);
	return file;
}

const allFiles = changedScriptFiles();
const { selected: files, skipped } = capMutationFiles(allFiles, maxFiles);
if (skipped.length > 0) {
	console.log(formatCapNotice(files.length, allFiles.length, skipped));
}
if (files.length === 0) {
	console.log("mutation diff: no changed scripts/**/*.mjs files");
	process.exit(0);
}

const { covered, uncovered, tests } = mapRelatedTests(files);
for (const file of uncovered) {
	console.log(`mutation diff: no covering test for ${file}`);
}
if (covered.length === 0) {
	console.log("mutation diff: no covered changed scripts; no mutants run");
	process.exit(0);
}

// Mutate the diff's own lines, not the whole changed file: whole-file
// instrumentation of scripts/check-pr-body.mjs alone is 2075 mutants, and every
// mutant reruns the related tests, so advisory run 36098718085 evaluated none of
// its 2220 before the 90-minute cap cancelled the job.
const patterns = mutationRangePatterns(covered, changedLineRanges(covered));

const configFile = writeRunConfig(tests);
console.log(`mutation diff: mutating ${patterns.join(", ")}`);
console.log(`mutation diff: running related tests ${tests.join(", ")}`);
console.log(`mutation diff: budget ${budgetMinutes} minute(s)`);
const result = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", patterns.join(","), configFile],
	{
		stdio: "inherit",
		encoding: "utf8",
		timeout: budgetMs,
		killSignal: "SIGTERM",
	},
);

if (result.error || result.status !== 0) {
	console.error(describeStrykerFailure(result, budgetMinutes));
	process.exit(1);
}

const reportPath = "reports/mutation/mutation.json";
if (!existsSync(reportPath)) {
	console.error("mutation diff: report not found after Stryker run");
	process.exit(1);
}

try {
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	// The mutation-report schema keys mutants by file; the entries themselves
	// carry no file name (spike 2026-09-09 printed `survived: undefined:59`).
	const mutants = Object.entries(report.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
	);
	const counts = mutants.reduce((out, mutant) => {
		out[mutant.status] = (out[mutant.status] ?? 0) + 1;
		return out;
	}, {});
	// The mutation-report schema stores no score; Stryker's definition is
	// (killed + timeout) / (total - ignored - no coverage).
	const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
	const denominator =
		mutants.length - (counts.Ignored ?? 0) - (counts.NoCoverage ?? 0);
	const score =
		denominator > 0 ? ((killed / denominator) * 100).toFixed(2) : "n/a";
	console.log(`mutation diff score: ${score}`);
	console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
	for (const mutant of mutants.filter((entry) => entry.status === "Survived")) {
		const line = mutant.location?.start?.line ?? "?";
		console.log(`survived: ${mutant.fileName}:${line} ${mutant.mutatorName}`);
	}
} catch (error) {
	console.error(`mutation diff: report unreadable: ${error.message}`);
	process.exit(1);
}

console.log("mutation diff: completed");
