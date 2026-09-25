import * as path from "node:path";
import type { TrivySecretFinding } from "../../secret-findings.js";
import type { TrivyFinding, TrivyResult } from "../../trivy-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A trivy finding is a CVE in a dependency — a *dependency-level* finding, not a
 * source location. Anchor it at the manifest/lockfile it was found in (`target`),
 * with no line. Advisory (warning); the CVE severity is carried in the message.
 */
export function trivyFindingToProjectDiagnostic(
	cwd: string,
	finding: TrivyFinding,
): ProjectDiagnostic {
	const filePath = finding.target
		? path.isAbsolute(finding.target)
			? finding.target
			: path.resolve(cwd, finding.target)
		: cwd;
	const version = finding.installedVersion
		? `@${finding.installedVersion}`
		: "";
	const fix = finding.fixedVersion ? ` (fixed in ${finding.fixedVersion})` : "";
	return {
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "trivy",
		runner: "trivy",
		rule: `trivy:${finding.vulnerabilityId}`,
		code: finding.pkgName,
		message: `${finding.severity} vulnerability ${finding.vulnerabilityId} in ${finding.pkgName}${version}${fix}`,
		source: "project-scan",
	};
}

/**
 * A trivy *secret* finding (`TrivyResult.secrets`) is a leaked credential at a
 * concrete `file:line` — the trivy-scanned sibling of
 * `gitleaksFindingToProjectDiagnostic`, and treated the same way: **blocking**,
 * since a committed credential is not a style nit.
 *
 * Rule id is namespaced `trivy-secret:<ruleId>`, deliberately distinct from the
 * CVE lane's `trivy:<vulnerabilityId>` (#1628) — trivy's own rule-id spaces for
 * secrets and CVEs are independent, so without this prefix a secret rule id
 * could collide with a vulnerability id and silently share (or steal) that
 * finding's disposition anchor.
 */
export function trivySecretFindingToProjectDiagnostic(
	cwd: string,
	finding: TrivySecretFinding,
): ProjectDiagnostic {
	return {
		filePath: path.isAbsolute(finding.file)
			? finding.file
			: path.resolve(cwd, finding.file),
		line: finding.line,
		severity: "error",
		semantic: "blocking",
		tool: "trivy",
		runner: "trivy",
		rule: `trivy-secret:${finding.ruleId}`,
		message: `Potential secret: ${finding.title || finding.ruleId}`,
		source: "project-scan",
	};
}

function trivySecretsToProjectDiagnostics(
	cwd: string,
	secrets: TrivySecretFinding[],
): ProjectDiagnostic[] {
	return secrets.map((finding) =>
		trivySecretFindingToProjectDiagnostic(cwd, finding),
	);
}

/**
 * Adapts BOTH of trivy's finding kinds from one scan pass — CVEs (`findings`)
 * and secrets (`secrets`, #1628) — into the single `ProjectDiagnostic[]`
 * `lens_diagnostics mode=full` surfaces. Before #1628, `secrets` was silently
 * unread here: a trivy-only secret (no gitleaks/ast-grep corroboration) had no
 * `lens_diagnostics`-visible identity at all for an agent to anchor a mark
 * against, even though `runtime-turn.ts`'s turn_end gate already blocked on it.
 */
export function trivyResultToProjectDiagnostics(
	cwd: string,
	result: TrivyResult,
): ProjectDiagnostic[] {
	if (!result.success) return [];
	return [
		...(result.findings ?? []).map((finding) =>
			trivyFindingToProjectDiagnostic(cwd, finding),
		),
		// `secrets` defaults to `[]` here rather than assuming the field is
		// always present: `fetchFreshProjectDiagnostics` swallows a task
		// rejection into a silent "completed" outcome (its
		// `.catch(() => "completed")`), so an unguarded `.map` on a missing
		// field here would drop this lane's CVE diagnostics too, not just the
		// secrets — a caller-visible regression for a field this adapter
		// doesn't itself require.
		...trivySecretsToProjectDiagnostics(cwd, result.secrets ?? []),
	];
}
