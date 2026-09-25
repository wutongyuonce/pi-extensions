import * as path from "node:path";
import type { GitleaksFinding, GitleaksResult } from "../../gitleaks-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A gitleaks finding is a leaked secret at a concrete `file:startLine`. Secrets
 * are treated as **blocking** — a committed credential is not a style nit.
 *
 * Exception: `pathStatus: "scratch"` (#1562 review-round F2) — a finding
 * `classifyAndFilterFindings` demoted rather than dropped, so the observability
 * criterion ("record carries tracked/ignored/scratch status") stays honest
 * about a fourth REACHABLE value instead of silently deleting it. Demoted to
 * `severity: "info"`/`semantic: "none"` so it can never read as a blocking
 * "leaked secret" alarm, while remaining visible for an audit read.
 */
export function gitleaksFindingToProjectDiagnostic(
	cwd: string,
	finding: GitleaksFinding,
): ProjectDiagnostic {
	// #1562 observability criterion: surface the git status right in the
	// finding's message so a triage is a read, not a re-derivation. Omitted
	// when git itself degraded (`pathStatus` undefined) rather than guessed.
	const statusSuffix = finding.pathStatus
		? ` [git: ${finding.pathStatus}]`
		: "";
	const isScratch = finding.pathStatus === "scratch";
	return {
		filePath: path.isAbsolute(finding.file)
			? finding.file
			: path.resolve(cwd, finding.file),
		line: finding.startLine,
		severity: isScratch ? "info" : "error",
		semantic: isScratch ? "none" : "blocking",
		tool: "gitleaks",
		runner: "gitleaks",
		rule: `gitleaks:${finding.ruleId}`,
		message: `Potential secret: ${finding.description || finding.ruleId}${statusSuffix}`,
		source: "project-scan",
	};
}

export function gitleaksResultToProjectDiagnostics(
	cwd: string,
	result: GitleaksResult,
): ProjectDiagnostic[] {
	if (!result.success || result.findings.length === 0) return [];
	return result.findings.map((finding) =>
		gitleaksFindingToProjectDiagnostic(cwd, finding),
	);
}
