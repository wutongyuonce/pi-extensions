import teardown, {
	localConfigPath,
	snapshotGitConfigState,
} from "./git-config-guard.js";

/**
 * The actual setup logic, against an injectable `cwd` so a unit test can
 * exercise the one-time-warn behavior against a controlled fixture instead
 * of the live repo's real git config.
 */
export function runGitConfigGuardSetup(cwd: string): () => void {
	// Snapshot BEFORE any test runs so the teardown guard can tell a real
	// local identity that already matched a fixture value (environment) from
	// contamination introduced during the run (#2251). Ordered after
	// prewarm-tool-home.ts in vitest.config.ts's sharedGlobalSetup — if that
	// step itself ever wrote a fixture-shaped git identity, this baseline
	// would already include it and the guard would treat it as environment,
	// not contamination. No known writer does this today; noted so a future
	// prewarm change that touches git config doesn't reintroduce a silent gap.
	const baseline = snapshotGitConfigState(localConfigPath(cwd));
	// #2251 AC: "pass or one-time warn" when a real identity coincides with a
	// fixture value. A silent pass would make leftover contamination from a
	// PRIOR crashed run (one that died before its own teardown could flag it)
	// permanently invisible for the rest of this worktree's life — every
	// later suite baselines it right back in. One line at suite start gives a
	// human something to notice without failing every run for a legitimate
	// coincidental identity.
	if (baseline.fixtureNames.size > 0 || baseline.fixtureEmails.size > 0) {
		const values = [...baseline.fixtureNames, ...baseline.fixtureEmails];
		console.warn(
			`[git-config-guard] fixture-shaped git identity already present at suite start: ${values.join(", ")}. ` +
				"If this is not your real identity, a prior run may have left contamination.",
		);
	}
	return () => teardown(baseline);
}

export default function setup(): () => void {
	return runGitConfigGuardSetup(process.cwd());
}
