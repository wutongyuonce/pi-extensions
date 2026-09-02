/**
 * Windows Ruby-installer drive-root version-dir discovery (refs #1137).
 *
 * The Ruby installer drops versioned directories (e.g. `Ruby34-x64`) directly
 * at a drive root, and the drive and version suffix vary — so both the LSP
 * candidate builder (`rubyBinCandidates`) and the spawn PATH augmenter
 * (`buildAugmentedPath`) scan the drive root for `ruby<N>...` directories.
 *
 * Enumerating a drive root **synchronously on every LSP spawn** was a genuine
 * #1137 event-loop offender: a stalled cloud/network-backed drive-root
 * `readdirSync` blocks the Node loop (and pi's TUI) for the entire stall. This
 * module makes that enumeration:
 *   1. **O(1) amortized** — the matching directory names are memoized for the
 *      process (the set is static for a session; the previous inline code
 *      equally required a restart to notice a new Ruby install on PATH), and
 *   2. **non-blocking on the hot path** — `buildAugmentedPath` (called on every
 *      spawn) reads the drive root via `fs.promises.readdir` off the loop.
 *
 * Both readers share ONE cache keyed by `driveRoot`, so at most one drive-root
 * read happens per drive per process regardless of which reader runs first.
 * Callers derive their own paths from the returned directory NAMES (the two
 * readers build different suffixes: `bin/<tool>` vs `bin`), so only the raw
 * `ruby<N>` names are cached.
 */
import { BoundedLruCache } from "../bounded-cache.js";
import { normalizeMapKey } from "../path-utils.js";

import * as fs from "node:fs";

/** Matches the Ruby installer's `Ruby34-x64`, `ruby3.3`, … drive-root dirs. */
const RUBY_VERSION_DIR = /^ruby\d/i;

/** Process-lifetime memo of matching dir names, keyed by drive root (e.g. `C:\`). */
const rubyDirNamesCache = new BoundedLruCache<string, string[]>(16);

function rubyDriveKey(driveRoot: string): string {
	return normalizeMapKey(driveRoot);
}

function filterRubyDirNames(entries: string[]): string[] {
	return entries.filter((name) => RUBY_VERSION_DIR.test(name));
}

/**
 * Memoized **synchronous** enumeration for sync callers (`rubyBinCandidates`).
 * First call reads the drive root once (fail-open to `[]` on an unreadable
 * root); every later call is a cache hit. If an async caller populated the
 * cache first, this returns that result with no drive-root read at all.
 */
export function getRubyVersionDirNamesSync(driveRoot: string): string[] {
	const key = rubyDriveKey(driveRoot);
	const cached = rubyDirNamesCache.get(key);
	if (cached !== undefined) return cached;
	let names: string[];
	try {
		names = filterRubyDirNames(fs.readdirSync(driveRoot));
	} catch {
		names = [];
	}
	rubyDirNamesCache.set(key, names);
	return names;
}

/**
 * Memoized **async** twin for the hot spawn path (`buildAugmentedPath`) — reads
 * the drive root via `fs.promises.readdir` so a slow/stalled cloud-backed drive
 * root never blocks the event loop. Shares the same process cache as the sync
 * reader (identical content, so a benign sync/async populate race is fine).
 */
export async function getRubyVersionDirNamesAsync(
	driveRoot: string,
): Promise<string[]> {
	const key = rubyDriveKey(driveRoot);
	const cached = rubyDirNamesCache.get(key);
	if (cached !== undefined) return cached;
	let names: string[];
	try {
		names = filterRubyDirNames(await fs.promises.readdir(driveRoot));
	} catch {
		names = [];
	}
	rubyDirNamesCache.set(key, names);
	return names;
}

/** Test-only: clear the process memo so each case starts cold. */
export function __resetRubyDriveDirsCacheForTest(): void {
	rubyDirNamesCache.clear();
}
