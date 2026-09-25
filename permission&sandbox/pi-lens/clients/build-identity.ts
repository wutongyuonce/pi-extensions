/**
 * #1775: `sessionstart.log` recorded no build identity — no commit hash, no
 * build timestamp. Dogfood forensics ("does this session include PR #1727?")
 * had to reconstruct that by hand: run `git merge-base --is-ancestor` in the
 * serving checkout and compare `dist/` mtimes against the session-start time.
 *
 * The running extension can be a different checkout than the repo an
 * investigator is looking at, so identity is derived from the RUNNING
 * build's own files — `getPackageRoot` (already used by grammar-source.ts to
 * find pi-lens's own assets under both the unbundled dev layout and a
 * packaged install) plus the mtime of the very entry file that is executing
 * right now — never from `process.cwd()` and never assumed to be a git
 * checkout.
 *
 * Commit resolution reuses `review-graph/git-identity.ts`'s
 * `resolveGitIdentity` — a PURE filesystem read, no `git` subprocess. This
 * runs inside the `session_start` handler, ahead of the #473
 * concurrent-secondary classification, so every in-process subagent pays
 * whatever this costs; a synchronous `git rev-parse`/`git status` spawn pair
 * (fix round 1's approach, reverted here) measured 150-300ms typical and up
 * to ~10s worst case on two 5s timeouts. `resolveGitIdentity` is a handful of
 * `fs.readFileSync` calls, LRU-cached per process, so this path never spawns.
 *
 * The dirty working-tree flag genuinely needs `git status`, which has no
 * spawn-free equivalent — so it is dropped from this record rather than
 * reintroducing a spawn on the session-start hot path (refs #1775 followup
 * comment: dirty flag deferred, commit + entryMtime + version shipped).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestMode } from "./env-utils.js";
import { getPackageRoot } from "./package-root.js";
import { normalizeFilePath } from "./path-utils.js";
import { resolveGitIdentity } from "./review-graph/git-identity.js";

export interface BuildIdentity {
	/** Short commit hash of the build's OWN checkout, or "unknown" — no `.git`
	 *  found, a packaged install with git metadata stripped, or (#2210 review
	 *  F2) a `.git` found only in an ANCESTOR directory that does not own this
	 *  package root (e.g. a dotfiles repo somewhere above a packaged install
	 *  under $HOME) — reporting that ancestor's commit would misattribute an
	 *  unrelated repo's history to this build. */
	commit: string;
	/** mtime of the running entry file (index.js) — the build's own timestamp,
	 *  correct under both the unbundled dev layout and a bundled `dist/` install. */
	entryMtime: string;
	/** package.json version — always available, the fallback identity for a
	 *  packaged install with no git metadata at all. */
	version: string;
}

/**
 * A `.git` found by walking up from `root` only counts as owning `root` when
 * its resolved worktree top-level IS `root` — not merely an ancestor of it.
 * Without this check, a packaged install nested anywhere under an unrelated
 * repo (a dotfiles checkout in $HOME is the common case) would confidently
 * report that repo's HEAD as the running build's identity.
 */
function resolveOwnedCommit(root: string): string {
	const identity = resolveGitIdentity(root);
	if (!identity) return "unknown";
	const normalizedRoot = normalizeFilePath(path.resolve(root));
	if (identity.worktreeRoot !== normalizedRoot) return "unknown";
	return identity.headCommit.slice(0, 8);
}

function readPackageVersion(root: string): string {
	try {
		const raw = fs.readFileSync(path.join(root, "package.json"), "utf-8");
		const pkg = JSON.parse(raw) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function statEntryMtime(entryImportMetaUrl: string): string {
	try {
		return fs.statSync(fileURLToPath(entryImportMetaUrl)).mtime.toISOString();
	} catch {
		// Entry path unresolvable (e.g. a non-file:// URL) — "unknown" rather
		// than throw out of a session-start observability line.
		return "unknown";
	}
}

/**
 * Resolve the identity of the build currently running — pure filesystem
 * reads, no subprocess. `entryImportMetaUrl` must be the ENTRY module's own
 * `import.meta.url` (index.ts) — passing a different module's URL would
 * report that module's mtime instead of the running build's.
 *
 * Returns `undefined` inside the test runner: nothing computed, nothing
 * logged (`sessionstart-logger`'s writer is a no-op there too), so a caller
 * on the session-start hot path never pays this cost during tests.
 */
export function getBuildIdentity(
	entryImportMetaUrl: string,
): BuildIdentity | undefined {
	if (isTestMode()) return undefined;
	const root = getPackageRoot(entryImportMetaUrl);
	return {
		commit: resolveOwnedCommit(root),
		entryMtime: statEntryMtime(entryImportMetaUrl),
		version: readPackageVersion(root),
	};
}

/** One bounded, human-readable line for sessionstart.log's free-text writer. */
export function formatBuildIdentity(identity: BuildIdentity): string {
	return `session_start: build identity — commit=${identity.commit} entryMtime=${identity.entryMtime} version=${identity.version}`;
}
