import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the config file that actually governs `repoRoot`. A linked
 * worktree's `.git` file points at a per-worktree gitdir
 * (`<main>/.git/worktrees/<name>`) that has no `config` of its own — Git
 * config for a worktree lives in the COMMON dir, named by that gitdir's
 * `commondir` file. Reading the per-worktree gitdir's (nonexistent) config
 * silently reports clean even when the shared config is contaminated
 * (#2163 F4: a guard run from the worktree must still see main-repo state).
 */
export function localConfigPath(repoRoot: string): string {
	const gitEntry = path.join(repoRoot, ".git");
	if (fs.existsSync(gitEntry) && fs.statSync(gitEntry).isFile()) {
		const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(gitEntry, "utf8"));
		if (match) {
			const gitDir = path.resolve(repoRoot, match[1].trim());
			const commondirFile = path.join(gitDir, "commondir");
			if (fs.existsSync(commondirFile)) {
				const commonDir = path.resolve(
					gitDir,
					fs.readFileSync(commondirFile, "utf8").trim(),
				);
				return path.join(commonDir, "config");
			}
			return path.join(gitDir, "config");
		}
	}
	return path.join(gitEntry, "config");
}

/**
 * Identities the fixture suite itself writes into a real Git config (see
 * tests/clients/metrics-history-stderr.test.ts, opaque-mutation-scan.test.ts,
 * git-tracked-ignore.test.ts, and .github/workflows/install-smoke.yml). The
 * guard flags ONLY these — a maintainer's legitimate `[user]` identity in the
 * main checkout must never trip it (#2163 F5: the prior version flagged any
 * local identity, which would red every local run once the guard actually
 * reaches the shared config via F4's commondir fix).
 */
export const KNOWN_FIXTURE_NAMES: ReadonlySet<string> = new Set([
	"pi-lens test",
	"t",
	"Test",
	"fixture",
	"pi-lens smoke",
]);
export const KNOWN_FIXTURE_EMAILS: ReadonlySet<string> = new Set([
	"test@example.com",
	"t@t.t",
	"t@t.local",
	"smoke@pi-lens.test",
]);

/**
 * The set of known-fixture values actually present in a config file, plus
 * the `core.bare` flag. Two snapshots let the guard tell "this fixture value
 * was already here when the suite started" (a real local identity that
 * happens to match a fixture name, e.g. `user.name=t` — environment, not
 * contamination) apart from "this fixture value appeared during the run"
 * (real contamination). Matching by presence-in-baseline, not by the literal
 * name/email string alone, is what makes a coincidental real identity safe
 * (#2251): a maintainer named "t" starts and ends the suite with "t" in
 * baseline and current alike, so nothing is "new".
 *
 * Consequence: baseline subtraction also makes contamination left over from
 * a PRIOR run that crashed before its own teardown ran permanently invisible
 * in this worktree — every later suite's baseline includes it, so it is
 * never "new" again. `git-config-guard-setup.ts` emits a one-time warning
 * naming any fixture-shaped value present at baseline for exactly this
 * reason (#2251's acceptance criteria call this "pass or one-time warn").
 */
export interface GitConfigSnapshot {
	readonly fixtureNames: ReadonlySet<string>;
	readonly fixtureEmails: ReadonlySet<string>;
	readonly bare: boolean;
}

const EMPTY_SNAPSHOT: GitConfigSnapshot = {
	fixtureNames: new Set(),
	fixtureEmails: new Set(),
	bare: false,
};

export function snapshotGitConfigState(configPath: string): GitConfigSnapshot {
	if (!fs.existsSync(configPath)) return EMPTY_SNAPSHOT;
	const text = fs.readFileSync(configPath, "utf8");
	let section = "";
	const fixtureNames = new Set<string>();
	const fixtureEmails = new Set<string>();
	let bare = false;
	for (const line of text.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]+)\]/.exec(line);
		if (header) {
			section = header[1].trim().toLowerCase().split(/\s+/)[0] ?? "";
			continue;
		}
		if (section === "user") {
			const nameMatch = /^\s*name\s*=\s*(.*?)\s*$/.exec(line);
			const emailMatch = /^\s*email\s*=\s*(.*?)\s*$/.exec(line);
			if (nameMatch && KNOWN_FIXTURE_NAMES.has(nameMatch[1]))
				fixtureNames.add(nameMatch[1]);
			if (emailMatch && KNOWN_FIXTURE_EMAILS.has(emailMatch[1]))
				fixtureEmails.add(emailMatch[1]);
		}
		if (section === "core" && /^\s*bare\s*=\s*true\s*$/i.test(line))
			bare = true;
	}
	return { fixtureNames, fixtureEmails, bare };
}

/**
 * Throw when `configPath` shows contamination that was NOT already present
 * in `baseline`. Omitting `baseline` treats "nothing present at start" as
 * the baseline, preserving the guard's original all-or-nothing behavior for
 * direct callers (e.g. unit tests exercising this function in isolation).
 */
export function assertCleanGitConfig(
	configPath: string,
	baseline: GitConfigSnapshot = EMPTY_SNAPSHOT,
): void {
	const current = snapshotGitConfigState(configPath);
	const newNames = [...current.fixtureNames].filter(
		(name) => !baseline.fixtureNames.has(name),
	);
	const newEmails = [...current.fixtureEmails].filter(
		(email) => !baseline.fixtureEmails.has(email),
	);
	const newBare = current.bare && !baseline.bare;
	if (newNames.length || newEmails.length || newBare) {
		const reason = newBare
			? "core.bare=true"
			: `known fixture identity (${[...newNames, ...newEmails].join(", ")})`;
		throw new Error(
			`Git contamination guard failed for ${configPath}: ${reason}`,
		);
	}
}

export default function teardown(baseline?: GitConfigSnapshot): void {
	assertCleanGitConfig(localConfigPath(process.cwd()), baseline);
}
