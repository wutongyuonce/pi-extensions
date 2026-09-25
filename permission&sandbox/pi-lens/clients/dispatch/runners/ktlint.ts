import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import {
	getAutofixCapability,
	getLinterPolicyForCwd,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const ktlint = createAvailabilityChecker("ktlint", ".exe");

// KtLint's exit contract, declared HERE rather than in the shared classifier:
// an admission is a property of this tool, and #3291 round 2 shipped it through
// a shared `parseToolRun` option that silently erased every OTHER runner's
// table. KtLint 1.8.0's CLI page documents the JSON reporter and a nonzero exit
// on violations, but does not enumerate numeric classes; 1, 2 and 3 are the
// statuses this runner observes carrying a valid reporter payload, and a valid
// payload is the evidence that analysis was reached. Any other nonzero status
// stays a rejected invocation.
const KTLINT_EXIT_CODES = { ran: [1, 2, 3] } as const;

interface KtlintError {
	line: number;
	col: number;
	detail: string;
	ruleId: string;
}

interface KtlintResult {
	file?: string;
	errors: KtlintError[];
}

function normalizeKtlintResults(parsed: unknown): KtlintResult[] | null {
	if (Array.isArray(parsed)) {
		return parsed as KtlintResult[];
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as KtlintResult).errors)
	) {
		return [parsed as KtlintResult];
	}
	return null;
}

function parseKtlintOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] | null {
	try {
		const parsed = normalizeKtlintResults(JSON.parse(raw));
		if (!parsed) return null;

		const autofix = getAutofixCapability("ktlint");
		const diagnostics: Diagnostic[] = [];
		const absTarget = path.resolve(cwd, filePath);
		for (const result of parsed) {
			// #3295: ktlint's JSON reporter is an array of FILES; `.editorconfig`
			// globs put more than the argv in it.
			if (result.file && !pathsEqual(path.resolve(cwd, result.file), absTarget))
				continue;
			for (const err of result.errors ?? []) {
				diagnostics.push({
					id: `ktlint-${err.ruleId}-${err.line}-${err.col}`,
					message: `[${err.ruleId}] ${err.detail}`,
					filePath,
					line: err.line,
					column: err.col,
					severity: "warning",
					semantic: "warning",
					tool: "ktlint",
					rule: err.ruleId,
					fixable: true,
					autoFixAvailable: autofix?.safePipelineAutofix ?? false,
					fixKind: autofix?.fixKind === "none" ? undefined : autofix?.fixKind,
				});
			}
		}
		return diagnostics;
	} catch {
		return null;
	}
}

const ktlintRunner: RunnerDefinition = {
	id: "ktlint",
	appliesTo: ["kotlin"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "ktlint");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("ktlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await ktlint.isAvailableAsync(cwd)) {
			cmd = ktlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["--reporter=json", absPath], {
			cwd,
			timeout: 30000,
		});

		// `output` is what the classifier judges AND what the parser reads: ktlint
		// writes its reporter payload to stdout and its errors to stderr, so both
		// are one wire here. The exit table rides in this same per-runner input,
		// never in a shared option (#3291 r3).
		const run = parseToolRun<Diagnostic>(
			"ktlint",
			{
				result,
				output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
				exitCodes: KTLINT_EXIT_CODES,
			},
			(output) => parseKtlintOutput(output, ctx.filePath, cwd) ?? [],
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "ktlint",
			ctx,
			result,
			diagnostics: run.diagnostics,
		});
	},
};

export default ktlintRunner;
