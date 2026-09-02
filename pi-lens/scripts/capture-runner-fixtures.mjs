#!/usr/bin/env node
/**
 * Re-capture the real-bytes runner fixtures (#1937).
 *
 * `capture-runner-output.mjs` captures ONE tool. This is the manifest of which
 * tools, against which committed workspace, with which argv — so a fixture can
 * be refreshed against a newer binary without anyone reconstructing the
 * invocation from a fixture's provenance header.
 *
 * Each entry's `argv` MUST mirror the argv its runner spawns, in order. The
 * argv-tie assertion in runners/captured-real-output.test.ts compares the two,
 * so an entry that drifts from its runner fails the suite rather than quietly
 * capturing bytes no runner would ever receive.
 *
 * Usage:
 *   node scripts/capture-runner-fixtures.mjs [runnerId ...] [--bin-dir DIR]
 *
 * Binaries are resolved as, in order: `<bin-dir>/<tool>[.exe|.bat]`, pi-lens's
 * own managed tool dirs, then bare `<tool>` on PATH. A tool that resolves
 * nowhere is REPORTED AND SKIPPED, never silently omitted: a capture run that
 * found no binaries must not look like a successful refresh.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const smoke = (dir) => `tests/fixtures/tool-smoke/${dir}`;

/**
 * One capture. `argv` mirrors the runner's own invocation; `file` is the
 * workspace-relative path the runner is pointed at.
 */
export const CAPTURES = [
	{
		runner: "actionlint",
		tool: "actionlint",
		workspace: smoke("actionlint"),
		file: ".github/workflows/ci.yml",
		argv: ["-format", "{{json .}}", ".github/workflows/ci.yml"],
	},
	{
		runner: "biome-check-json",
		tool: "biome",
		workspace: smoke("javascript"),
		file: "bad.js",
		argv: ["lint", "--reporter=json", "--no-errors-on-unmatched", "bad.js"],
	},
	{
		runner: "hadolint",
		tool: "hadolint",
		workspace: smoke("dockerfile"),
		file: "Dockerfile",
		argv: ["--format", "json", "--no-fail", "Dockerfile"],
	},
	{
		// #1839/#1994 — pins the CORRECTED --rules argv (comma-separated ruleid
		// list) producing findings on exit 1. The pre-fix runner fed --rules a
		// JSON object, which left zero rules enabled and exited 0 clean on any
		// file.
		runner: "htmlhint",
		tool: "htmlhint",
		workspace: smoke("html"),
		file: "bad.html",
		argv: [
			"--rules",
			"tag-pair,attr-no-duplication,tagname-lowercase,spec-char-escape,id-unique",
			"--format",
			"unix",
			"bad.html",
		],
	},
	{
		runner: "markdownlint",
		tool: "markdownlint",
		bin: "markdownlint-cli2",
		workspace: smoke("markdown"),
		file: "bad.md",
		argv: ["bad.md"],
	},
	{
		runner: "mypy",
		tool: "mypy",
		workspace: smoke("python-types"),
		file: "bad.py",
		argv: ["--no-error-summary", "--show-column-numbers", "bad.py"],
	},
	{
		runner: "oxlint",
		tool: "oxlint",
		workspace: smoke("js-oxlint-error"),
		file: "bad.js",
		argv: ["--format", "json", "bad.js"],
	},
	{
		// #1947 — oxlint exits 0 when every finding is warning severity (its
		// default). No .oxlintrc.json override here, unlike js-oxlint-error,
		// so the capture pins the exit-0-with-findings case #1946 deliberately
		// left uncaptured.
		runner: "oxlint",
		case: "warning-exit-zero",
		tool: "oxlint",
		workspace: smoke("js-oxlint-warning"),
		file: "bad.js",
		argv: ["--format", "json", "bad.js"],
	},
	{
		// #1954 — ESLint also exits 0 when every finding is warning severity
		// (--max-warnings unset). No rule in modern @eslint/js recommended
		// ships at "warn" anymore, so js-eslint-warning's config downgrades
		// no-unused-vars explicitly — still the exit-0-with-findings shape.
		runner: "eslint",
		case: "warning-exit-zero",
		tool: "eslint",
		workspace: smoke("js-eslint-warning"),
		file: "bad.js",
		argv: ["--format", "json", "--no-error-on-unmatched-pattern", "bad.js"],
	},
	{
		runner: "php-lint",
		tool: "php",
		workspace: smoke("php"),
		file: "syntax-error.php",
		argv: ["-l", "syntax-error.php"],
	},
	{
		runner: "phpstan",
		tool: "phpstan",
		workspace: smoke("phpstan"),
		file: "bad.php",
		argv: ["analyse", "--error-format=json", "--no-progress", "bad.php"],
	},
	{
		runner: "phpstan",
		case: "top-level-errors",
		tool: "phpstan",
		workspace: smoke("phpstan-internal"),
		file: "clean.php",
		note: "an unmatched ignore pattern: a finding phpstan reports outside files{}",
		argv: ["analyse", "--error-format=json", "--no-progress"],
	},
	{
		runner: "pyright",
		tool: "pyright",
		workspace: smoke("python-types"),
		file: "bad.py",
		argv: ["--outputjson", "bad.py"],
	},
	{
		runner: "ruff-lint",
		tool: "ruff",
		workspace: smoke("python"),
		file: "bad.py",
		argv: ["check", "--output-format", "json", "bad.py"],
	},
	{
		runner: "shellcheck",
		tool: "shellcheck",
		workspace: smoke("shell"),
		file: "bad.sh",
		argv: [
			"--format",
			"json",
			"--shell",
			"bash",
			"--severity",
			"info",
			"bad.sh",
		],
	},
	{
		runner: "shfmt",
		tool: "shfmt",
		workspace: smoke("shell"),
		file: "bad.sh",
		argv: ["--diff", "bad.sh"],
	},
	{
		runner: "spellcheck",
		tool: "typos",
		workspace: smoke("typos-aux"),
		file: "notes.md",
		argv: ["--format", "json", "notes.md"],
	},
	{
		// No .sqlfluff in this workspace, so the runner appends `--dialect
		// ansi` AFTER `--format json`. Capturing the configured order instead
		// would hide #1937's argv bug, which put `--dialect` between `--format`
		// and its value.
		runner: "sqlfluff",
		tool: "sqlfluff",
		workspace: smoke("sql"),
		file: "bad.sql",
		argv: ["lint", "--format", "json", "--dialect", "ansi", "bad.sql"],
	},
	{
		runner: "stylelint",
		tool: "stylelint",
		workspace: smoke("css"),
		file: "bad.css",
		argv: ["--formatter", "json", "bad.css"],
	},
	{
		runner: "taplo",
		tool: "taplo",
		workspace: smoke("toml"),
		file: "bad.toml",
		argv: ["check", "--colors", "never", "bad.toml"],
	},
	{
		runner: "terragrunt",
		tool: "terragrunt",
		workspace: smoke("terragrunt"),
		file: "terragrunt.hcl",
		argv: ["hcl", "validate", "--json", "--non-interactive"],
	},
	{
		runner: "tflint",
		tool: "tflint",
		workspace: smoke("terraform"),
		file: "bad.tf",
		argv: ["--format=json", "--no-color", "--filter=bad.tf"],
	},
	{
		runner: "vale",
		tool: "vale",
		workspace: smoke("vale"),
		file: "bad.md",
		argv: ["--output", "JSON", "bad.md"],
	},
	{
		runner: "yamllint",
		tool: "yamllint",
		workspace: smoke("yaml"),
		file: "bad.yaml",
		argv: ["-f", "parsable", "bad.yaml"],
	},
];

/** Directories searched for a tool binary, in order. */
function candidateDirs(binDir) {
	const home = os.homedir();
	return [
		binDir,
		path.join(home, ".pi-lens", "bin"),
		path.join(home, ".pi-lens", "tools", "node_modules", ".bin"),
	].filter(Boolean);
}

/** Absolute path to `name`'s binary, or the bare name to fall back to PATH. */
export function resolveBin(name, binDir) {
	for (const dir of candidateDirs(binDir)) {
		for (const suffix of [".exe", ".bat", ".cmd", ""]) {
			const candidate = path.join(dir, `${name}${suffix}`);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return name;
}

function main() {
	const argv = process.argv.slice(2);
	let binDir = null;
	const only = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--bin-dir") binDir = argv[++i];
		else only.push(argv[i]);
	}

	const selected = only.length
		? CAPTURES.filter((c) => only.includes(c.runner))
		: CAPTURES;
	if (selected.length === 0) {
		console.error(`no capture matched: ${only.join(", ")}`);
		process.exit(2);
	}

	let captured = 0;
	const skipped = [];
	for (const entry of selected) {
		const bin = resolveBin(entry.bin ?? entry.tool, binDir);
		const source = path.join(repoRoot, entry.workspace);
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-capture-"),
		);
		try {
			fs.cpSync(source, workspace, { recursive: true });
			execFileSync(
				process.execPath,
				[
					path.join(__dirname, "capture-runner-output.mjs"),
					"--runner",
					entry.runner,
					"--tool",
					entry.tool,
					"--bin",
					bin,
					"--cwd",
					workspace,
					"--workspace",
					entry.workspace,
					"--file",
					entry.file,
					"--case",
					entry.case ?? "real",
					...(entry.note ? ["--note", entry.note] : []),
					...(entry.shell ? ["--shell", entry.shell] : []),
					"--",
					...entry.argv,
				],
				{ stdio: "inherit" },
			);
			captured++;
		} catch (err) {
			skipped.push(`${entry.runner}: ${err?.message ?? err}`);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	}

	console.log(`\n${captured} captured, ${skipped.length} skipped`);
	for (const reason of skipped) console.log(`  skipped ${reason}`);
	// A run that captured nothing is a failed refresh, not a quiet success.
	process.exit(captured === 0 ? 1 : 0);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main();
}
