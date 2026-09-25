/**
 * Path utilities for pi-lens
 *
 * Handles cross-platform path normalization, particularly
 * Windows case-insensitivity issues when using paths as Map keys.
 *
 * Approach (inspired by OpenCode's Filesystem.normalizePath):
 * - On Windows: try realpathSync.native() for canonical casing
 * - Falls back to lowercase for files that don't exist yet
 * - On non-Windows: return path as-is (case-sensitive filesystem)
 * - Always convert backslashes to forward slashes for Map key consistency
 */

import { type Dirent, existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minimatch } from "./deps/minimatch.js";

/**
 * Detect a positively Windows-shaped path, regardless of the host OS.
 *
 * A backslash anywhere in a path is not enough: it is a legal character in a
 * POSIX filename. Only a drive-letter prefix (`X:`), a UNC root (`\\`), or a
 * rooted backslash at position zero (`\`) selects Windows parsing.
 */
export function isWindowsPath(filePath: string): boolean {
	return /^[A-Za-z]:/.test(filePath) || filePath.startsWith("\\");
}

/**
 * Canonical backslash→forward-slash fold — the single sanctioned form of the
 * `p.replace(/\\/g, "/")` idiom otherwise hand-rolled across the codebase
 * (~138 sites, #1193). PURE separator normalization: it does NOT resolve,
 * canonicalize, lowercase, or collapse repeated slashes — reach for
 * `normalizeFilePath`/`normalizeMapKey`/`normalizeEphemeralMapKey` when a
 * canonical map *key* (case-fold / realpath) is what you need. Consolidating on
 * this funnels the scattered transform and makes a shape-2 lint/ast-grep rule
 * possible for the first time: today a bare inline `.replace(/\\/g, "/")` is
 * byte-identical to the sanctioned use so it can't be ruled (#1158); once
 * everything routes through `toPosix`, an *un-migrated* inline `.replace`
 * becomes detectable.
 */
export function toPosix(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

/** Return whether `filePath` is fully qualified under Windows semantics. */
export function isFullyQualifiedWin32(filePath: string): boolean {
	return win32.isAbsolute(filePath) && win32.parse(filePath).root.length > 1;
}

/** Return whether `filePath` is fully qualified under POSIX semantics. */
export function isFullyQualifiedPosix(filePath: string): boolean {
	return path.posix.isAbsolute(filePath) && !isWindowsPath(filePath);
}

/**
 * Return whether `filePath` is fully qualified under the host's semantics.
 *
 * In particular, `/foo` is rooted-relative under Win32 (ambient-drive
 * dependent) but fully qualified under POSIX.
 */
export function isFullyQualified(filePath: string): boolean {
	return process.platform === "win32"
		? isFullyQualifiedWin32(filePath)
		: isFullyQualifiedPosix(filePath);
}

/**
 * Split a path into its non-empty segments on EITHER separator (`\` or `/`),
 * regardless of the running OS — the shape-safe form of `p.split(path.sep)` /
 * an inline `p.split(/[\\/]+/)`, which #1161/#1163 showed must not assume the
 * host separator for a possibly-cross-shaped path. Drops empty segments
 * (leading slash, drive-root, doubled separators).
 */
export function splitPathSegments(filePath: string): string[] {
	return filePath.split(/[\\/]+/).filter(Boolean);
}

/**
 * Normalize a file path for consistent Map key usage.
 *
 * On Windows:
 * - If the file exists: uses realpathSync.native() to get the canonical
 *   filesystem path (actual casing, resolved symlinks)
 * - If the file doesn't exist: resolves the path and lowercases
 *   (needed for new files where we haven't written yet)
 *
 * On non-Windows: returns path as-is (case-sensitive filesystem).
 *
 * Always converts backslashes to forward slashes for consistent Map keys.
 */
export function normalizeFilePath(filePath: string): string {
	// Convert backslashes to forward slashes first
	const normalized = filePath.replace(/\\/g, "/");

	if (process.platform !== "win32" && !isWindowsPath(normalized)) {
		return normalized;
	}

	// Windows: try realpathSync.native() for canonical casing
	// This resolves symlinks and returns the actual filesystem casing
	try {
		const canonical = realpathSync.native(filePath);
		return canonical.replace(/\\/g, "/");
	} catch {
		// File doesn't exist yet (new file) — resolve path and lowercase
		// We need to walk up the directory tree to find the nearest existing
		// parent, resolve its casing, then append the non-existent parts
		try {
			return resolveNonExisting(filePath);
		} catch {
			// Last resort: just lowercase the resolved path
			const resolved = win32.normalize(win32.resolve(filePath));
			return resolved.replace(/\\/g, "/").toLowerCase();
		}
	}
}

/**
 * Normalize a logged `filePath`/`cwd` value, but ONLY when it is already a
 * fully-qualified path (#2219, the #2141 class's sibling loggers). Several
 * NDJSON log-entry types reuse a `filePath`-typed field for non-path
 * sentinels alongside genuine paths — `"<quiet-window>"` in
 * `cascade-logger.ts`, `"<tree-sitter>"` in `tree-sitter-logger.ts`, a shell
 * command or an empty placeholder in `latency-logger.ts`. `normalizeFilePath`
 * resolves a relative-looking string against the CURRENT process cwd (see
 * `resolveNonExisting` above), so running it over one of those sentinels
 * would silently corrupt it into `"<repoRoot>/<quiet-window>"` instead of
 * normalizing it. Only a value that is already fully qualified can be the
 * #2141 mixed-raw/normalized-path defect; anything else is passed through
 * unchanged.
 *
 * #2229 review round 1, F1: this classifier checks BOTH host shapes
 * (`isFullyQualifiedWin32(value) || isFullyQualifiedPosix(value)`), not
 * `isFullyQualified(value)` (host-dispatched on `process.platform`). A
 * Windows-shaped absolute path (`C:\Users\...`) is exactly the log payload
 * this fix exists to normalize, but `isFullyQualified` on Linux CI routes to
 * `isFullyQualifiedPosix`, which rejects it (no leading `/`) — so on Linux
 * the guard silently no-ops for the very inputs the #2141 defect produces,
 * passing the raw backslash form straight through. Checking both shapes
 * makes the classifier's answer for a given STRING independent of which OS
 * is asking; `normalizeFilePath` itself still branches on `process.platform`
 * for how the file is resolved, but whether to normalize at all no longer
 * does (AGENTS.md shape 2, the #1024/#1150 OS-divergence class).
 */
export function normalizeLoggedPath(value: string): string {
	return isFullyQualifiedWin32(value) || isFullyQualifiedPosix(value)
		? normalizeFilePath(value)
		: value;
}

/**
 * Resolve a non-existing path by finding the nearest existing parent,
 * getting its canonical casing, then appending the non-existent parts lowercased.
 *
 * Example: C:\Users\Foo\newdir\file.ts
 * - C:\Users\Foo exists → realpathSync gives C:\Users\Foo
 * - newdir\file.ts doesn't exist → lowercased
 * - Result: C:/Users/Foo/newdir/file.ts
 */
function resolveNonExisting(filePath: string): string {
	const resolved = win32.resolve(filePath);
	let current = resolved;
	const nonExistentParts: string[] = [];

	// Walk up until we find an existing directory
	while (true) {
		if (existsSync(current)) {
			// Found existing ancestor — get its canonical casing
			const canonical = realpathSync.native(current);
			if (nonExistentParts.length === 0) {
				return canonical.replace(/\\/g, "/");
			}
			// Append non-existent parts (lowercased for consistency)
			const tail = nonExistentParts.reverse().join("/").toLowerCase();
			const base = canonical.replace(/\\/g, "/");
			return base.endsWith("/") ? base + tail : `${base}/${tail}`;
		}

		// Use win32.dirname (not the platform-default dirname) so a
		// Windows-shaped path is parsed with win32 semantics regardless of the
		// running OS — consistent with the win32.resolve/win32.normalize this
		// branch already commits to. The platform-default POSIX dirname would
		// find no separator in a win32-resolved "C:\repo\..." path (its only
		// separators are backslashes), collapse to ".", stop the upward walk at
		// cwd, and mangle the key on Linux CI (refs #1150, the #1024
		// OS-divergence class).
		const parent = win32.dirname(current);
		if (parent === current) {
			// Reached filesystem root without finding existing dir
			// Fall back to full lowercase
			throw new Error("No existing parent found");
		}

		nonExistentParts.push(win32.basename(current));
		current = parent;
	}
}

/**
 * Convert a file:// URI to a normalized path.
 * Handles URL decoding and Windows drive letter normalization.
 */
export function uriToPath(uri: string): string {
	try {
		const filePath = fileURLToPath(uri);
		return normalizeFilePath(filePath);
	} catch {
		// Not a valid file:// URI, treat as plain path
		return normalizeFilePath(uri);
	}
}

/**
 * Decode a file:// URI to an on-disk path WITHOUT map-key normalization.
 *
 * `uriToPath` runs its result through `normalizeFilePath`, which on win32
 * lowercases the nonexistent tail of a path (see `resolveNonExisting`) and
 * canonicalizes an existing path to its real casing. That is correct for Map
 * keys, but DESTRUCTIVE for a real create/rename target: creating `NewFile.txt`
 * would write `newfile.txt`, and a legitimate case-only rename would collapse
 * to a no-op ("source and destination must differ"). Disk mutations must honor
 * the caller's intended casing, so they resolve their target through this
 * decode-only path while confinement/validation keep using the normalized
 * `uriToPath`. Non-win32 is unaffected either way (normalizeFilePath is a
 * near-identity there).
 */
export function uriToDiskPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		// Not a valid file:// URI — treat as a plain path (matches uriToPath).
		return uri;
	}
}

/**
 * Convert a path to a file:// URI.
 * Does NOT normalize the path - URIs preserve original casing.
 */
export function pathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Normalize a Map key lookup for file paths.
 * Use this when getting/setting values in Maps that use file paths as keys.
 */
export function normalizeMapKey(filePath: string): string {
	return normalizeFilePath(filePath);
}

/**
 * Human-facing path relative to a project root when the file is inside it.
 *
 * Parses by path SHAPE, not host OS (refs #1150/#1152, shape-2 class #1163):
 * a Windows-shaped `filePath` (drive-letter/UNC — e.g. a persisted call-graph
 * symbol-key path `C:\repo\src\x.ts` rehydrated on a Linux CI run) is split
 * with `win32.*` regardless of `process.platform`. The host-default
 * `isAbsolute`/`relative` find no drive-letter anchor in a win32 path on POSIX:
 * `path.isAbsolute("C:\\repo\\x.ts")` returns FALSE on Linux, short-circuiting
 * to the raw absolute path instead of ever relativizing it — so a file that IS
 * under the project root renders as a full absolute path on Linux but the
 * expected `src/x.ts` on Windows (green-locally / wrong-on-CI, the #1024
 * divergence class). `win32.*` on a native POSIX path (Windows never sees one;
 * Linux native paths aren't Windows-shaped) is never selected, so same-OS
 * native paths are unchanged either way.
 */
export function toProjectRelativePath(
	filePath: string,
	projectRoot: string,
): string {
	const p = isWindowsPath(filePath) ? win32 : path;
	if (!p.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
	const relative = p.relative(p.resolve(projectRoot), filePath);
	return relative && !relative.startsWith("..") && !p.isAbsolute(relative)
		? relative.replace(/\\/g, "/")
		: filePath.replace(/\\/g, "/");
}

/**
 * Cheap, syntactic-only Map key normalization: slash-fold + (on Windows)
 * lowercase. No `realpathSync` / filesystem I/O.
 *
 * `normalizeMapKey` (via `normalizeFilePath`) calls `realpathSync.native()` to
 * get canonical on-disk casing — correct for maps that key long-lived state
 * shared across call sites (e.g. LSP/read-guard caches), but expensive when
 * the *point* of the cache is to avoid filesystem calls in the first place:
 * for a candidate path that does NOT exist (the common case for sibling-probe
 * memos), `normalizeFilePath` walks up the directory tree doing its own
 * `existsSync` calls to resolve the nearest existing ancestor — measured at
 * ~11x slower than the single `existsSync` probe such a cache is trying to
 * save (refs #191).
 *
 * Safe to use ONLY for ephemeral, single-process, single-walk caches whose
 * keys are produced by this process's own `path.join`/`path.resolve` calls
 * within the same run (so separators and casing are already consistent
 * modulo simple slash direction) — never for state shared across processes,
 * persisted, or compared against externally-supplied paths where symlink /
 * real-casing resolution actually matters.
 */
export function normalizeEphemeralMapKey(filePath: string): string {
	// Most hot-path keys on POSIX are already canonical slash-separated strings.
	// Preserve that identity instead of allocating a replacement string for each
	// file in a large diagnostics reconciliation.
	if (process.platform !== "win32" && !filePath.includes("\\")) return filePath;
	const slashed = filePath.replace(/\\/g, "/");
	return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Compare two file paths for equality, handling Windows case-insensitivity
 * and mixed separators (backslash vs forward slash).
 */
export function pathsEqual(a: string, b: string): boolean {
	return normalizeFilePath(a) === normalizeFilePath(b);
}

/**
 * Check if `child` is under `parent` directory.
 * Separator-agnostic and case-insensitive on Windows.
 */
/**
 * Yield each directory from `startDir` up to (and including) the filesystem
 * root. Terminates when `path.dirname(current) === current` so it works on
 * Windows drive roots and POSIX `/` alike.
 *
 * Single source of truth for the half-dozen "walk up the directory tree
 * looking for X" loops that have accumulated across the codebase. Callers
 * that need an "is there a file named Y anywhere on the way up" check
 * should use `findNearestContaining` instead.
 */
export function* walkUpDirs(startDir: string): Generator<string> {
	let current = path.resolve(startDir);
	while (true) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/**
 * Walk up from `startDir` and return the first directory that contains any
 * of `candidates` on disk. Returns `undefined` if none match.
 *
 * @example
 *   findNearestContaining("/repo/pkg/src", ["package.json", "tsconfig.json"]);
 *   // → "/repo/pkg" if pkg/package.json exists, "/repo" if only /repo/package.json
 */
export function findNearestContaining(
	startDir: string,
	candidates: readonly string[],
): string | undefined {
	for (const dir of walkUpDirs(startDir)) {
		for (const name of candidates) {
			if (existsSync(path.join(dir, name))) return dir;
		}
	}
	return undefined;
}

/**
 * Walk up from `startDir` and return the first matching FILE path (not just
 * the containing directory) for any of `names`, first-match-wins within each
 * directory in `names` order. Single source of truth for the "walk up
 * looking for one of these config filenames" loop that `opengrep-config.ts`,
 * `typos-config.ts`, `zizmor-config.ts`, and `sgconfig.ts` each hand-rolled
 * independently (refs #680).
 *
 * Distinct from `findNearestContaining`, which returns the containing
 * directory rather than the matched file path — use that one when the caller
 * only needs "is one of these present nearby", not which file it is.
 *
 * @example
 *   findLocalToolConfig(cwd, ["typos.toml", "_typos.toml", ".typos.toml"]);
 *   // → "/repo/typos.toml" if present, else undefined
 */
export function findLocalToolConfig(
	startDir: string,
	names: readonly string[],
): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface FindNearestMarkerRootOptions {
	/**
	 * Directory names/files that, if found BEFORE any of `markers`, stop the
	 * walk and make it return `null` — e.g. `.git`/`.hg`/`.svn` so a search
	 * starting inside a repo without its own project marker doesn't escape
	 * past that repo's VCS boundary to pick up an unrelated parent's marker.
	 * Omit for callers with no such boundary (default: none).
	 */
	boundaries?: readonly string[];
	/** Override for `os.homedir()`, primarily for tests. */
	homeDir?: string;
}

/**
 * Walk up from `startDir` looking for a directory containing any of
 * `markers`, the same containment-aware climb `knip-client.ts` and
 * `dead-code-client.ts` each used to hand-roll independently (refs #625):
 *
 *   - Never resolves at or above `$HOME` (via `isAtOrAboveHomeDir`) — a
 *     marker found there has escaped the user's workspace.
 *   - If `options.boundaries` is given and one is found before any `marker`,
 *     stops and returns `null` rather than continuing past it.
 *   - Depth-capped at 64 climbs, matching the callers' existing safety bound
 *     (guards a pathological symlink loop; real depths are ~10).
 *   - Returns `null` — never `startDir` — when nothing is found. Callers
 *     must treat `null` as "no project here", not fall back to the start
 *     directory (a `null`-swallowing fallback was the #250/#296 bug class:
 *     scanning $HOME wholesale from a bare cwd).
 *
 * For a plain "find nearest containing directory" with no boundary concept,
 * use `findNearestContaining` instead. Distinct from `startup-scan.ts`'s
 * `findNearestProjectRoot` (fixed marker list, no boundaries, no home-check —
 * that caller applies `isAtOrAboveHomeDir` itself afterward); named
 * differently here to avoid confusion between the two.
 */
export function findNearestMarkerRoot(
	startDir: string,
	markers: readonly string[],
	options: FindNearestMarkerRootOptions = {},
): string | null {
	const boundaries = options.boundaries ?? [];
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	let current = path.resolve(startDir);
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) return null;
		if (markers.some((m) => existsSync(path.join(current, m)))) return current;
		if (boundaries.some((m) => existsSync(path.join(current, m)))) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * True when `dir` is the home directory OR an ancestor of it (`/home`,
 * `C:\Users`, the filesystem root, …). A project-root search that climbs to
 * such a directory has escaped the user's workspace — walking down from it
 * scans unrelated trees (the #250 runaway). Use this as the single shared
 * ceiling on any upward project-root resolution, instead of an exact
 * `=== os.homedir()` check (which a marker found *above* `$HOME` slips past).
 * A normal project *under* home (e.g. `~/code/app`) is NOT at-or-above home,
 * so it still resolves fine. Refs #253.
 */
export function isAtOrAboveHomeDir(
	dir: string,
	homeDir: string = os.homedir(),
): boolean {
	const resolvedDir = path.resolve(dir);
	const resolvedHome = path.resolve(homeDir);
	if (resolvedDir === resolvedHome) return true;
	// `dir` is an ancestor of home ⇢ home lies inside dir ⇢ the relative path
	// from dir to home has no leading `..` and is not absolute (cross-drive on
	// Windows yields an absolute rel, correctly treated as "not above").
	const rel = path.relative(resolvedDir, resolvedHome);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isUnderDir(child: string, parent: string): boolean {
	const normChild = normalizeFilePath(child);
	const normParent = normalizeFilePath(parent);
	// Ensure parent ends with / for prefix matching
	const parentPrefix = normParent.endsWith("/") ? normParent : `${normParent}/`;
	return normChild === normParent || normChild.startsWith(parentPrefix);
}

const VENDOR_DIR_NAMES = new Set([
	"node_modules",
	"vendor",
	"vendors",
	"third_party",
	"third-party",
]);

/**
 * Returns true when a file should be treated as external/vendor and excluded
 * from pipelines (LSP, diagnostics, complexity, read-guard, etc.).
 *
 * Cases:
 *   1. Outside the project root entirely (e.g. global npm packages, system files)
 *   2. Inside the project but under a vendor directory (node_modules, vendor, third_party, etc.)
 */
export function isExternalOrVendorFile(
	filePath: string,
	projectRoot: string,
): boolean {
	if (!isUnderDir(filePath, projectRoot)) return true;
	const normalized = normalizeFilePath(filePath);
	const rootNorm = normalizeFilePath(projectRoot);
	const rel = normalized.startsWith(rootNorm + "/")
		? normalized.slice(rootNorm.length + 1)
		: normalized;
	return rel.split("/").some((seg) => VENDOR_DIR_NAMES.has(seg));
}

/**
 * Shared marker-glob semantics for every "does this directory contain a file
 * matching this glob" probe (#895 review): match against the entry NAME only,
 * `dot: true` so dotfile markers match, `nocase` on win32 to match the
 * filesystem (and the project ignore matcher). The three marker probes —
 * language-profile.ts `hasProjectMarker`, workspace-topology.ts
 * `hasBasenameMarker`, lsp/server.ts `markerExists` — must all route their
 * glob matching through here rather than call minimatch with hand-copied
 * options.
 */
export function nameMatchesMarkerGlob(name: string, pattern: string): boolean {
	return minimatch(name, pattern, {
		dot: true,
		nocase: process.platform === "win32",
	});
}

/**
 * Files/symlinks-only marker-glob probe over a directory listing — a
 * *directory* named like a marker (e.g. a `Foo.csproj/` dir) is not a project
 * file (#201).
 */
export function direntsHaveMarkerGlobMatch(
	entries: readonly Dirent[],
	pattern: string,
): boolean {
	return entries.some(
		(entry) =>
			(entry.isFile() || entry.isSymbolicLink()) &&
			nameMatchesMarkerGlob(entry.name, pattern),
	);
}

/**
 * Narrow no-break space, U+202F. macOS writes it before AM/PM in screenshot
 * file names; users type an ordinary space.
 */
const NARROW_NO_BREAK_SPACE = "\u202F";
/** Right single quotation mark, U+2019. macOS writes it; users type U+0027. */
const RIGHT_SINGLE_QUOTE = "\u2019";

/**
 * The unicode space class pi folds to U+0020, copied character-for-character
 * from `@earendil-works/pi-coding-agent/dist/utils/paths.js:6`
 * (`UNICODE_SPACES`, source `src/utils/paths.ts`). Widening or narrowing this
 * set makes pi-lens resolve a different file than pi does.
 */
const HOST_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirror pi's `normalizeWindowsShellPath`
 * (`@earendil-works/pi-coding-agent/dist/utils/paths.js:47-56`): convert Git
 * Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs
 * accept.
 */
function hostNormalizeWindowsShellPath(filePath: string): string {
	if (
		!filePath.startsWith("/") ||
		filePath.startsWith("//") ||
		filePath.includes("\\")
	) {
		return filePath;
	}
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

interface HostNormalizeOptions {
	/** Fold the unicode space class to U+0020. */
	normalizeUnicodeSpaces?: boolean;
	/** Drop a single leading `@` (pi's file-mention prefix). */
	stripAtPrefix?: boolean;
}

/**
 * Mirror pi's `normalizePath`
 * (`@earendil-works/pi-coding-agent/dist/utils/paths.js:57-79`, source
 * `src/utils/paths.ts`), in pi's order, which is load-bearing: the unicode
 * fold runs BEFORE the `@` strip, and the tilde expansion before the
 * `file://` conversion.
 *
 * The `win32` step is gated on `process.platform`, exactly as pi gates it.
 * This is a deliberate exception to the usual probe-the-filesystem rule
 * (AGENTS.md shape 2): pi-lens runs in pi's own process, so mirroring the
 * host's own platform branch is what keeps the two resolvers in agreement.
 * Shape-based parsing here would DIVERGE from the host, not protect against
 * it.
 */
export function normalizeHostToolPath(
	input: string,
	options: HostNormalizeOptions = {},
): string {
	let normalized = input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(HOST_UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = hostNormalizeWindowsShellPath(normalized);
	}
	// `homedir()` is resolved inside the branch, as pi does. This runs on every
	// tool_call and a `~` path is the rare case.
	if (normalized === "~") return os.homedir();
	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			// pi lets a malformed file: URL throw out of normalizePath, but pi-lens
			// is advisory instrumentation on the same event: a URL pi rejects must
			// degrade to "no path" here, never take down the tool_call handler.
			return normalized;
		}
	}
	return normalized;
}

/**
 * Mirror pi's `resolveToCwd`
 * (`@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:42-44`,
 * source `src/core/tools/path-utils.ts:~44-46`) \u2014 the BASE resolution every
 * read/edit/write path goes through before the variant ladder below ever
 * runs.
 *
 * Two details are pi's, not ours, and both matter:
 *   - the input is normalized with `normalizeUnicodeSpaces` + `stripAtPrefix`;
 *     the BASE DIR is normalized with neither (`resolvePath`,
 *     `dist/utils/paths.js:80-84`).
 *   - an already-absolute input is re-resolved on its own, ignoring the cwd.
 */
export function resolveHostToolPath(input: string, baseDir: string): string {
	const normalized = normalizeHostToolPath(input, {
		normalizeUnicodeSpaces: true,
		stripAtPrefix: true,
	});
	const normalizedBaseDir = normalizeHostToolPath(baseDir);
	return path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(normalizedBaseDir, normalized);
}

export interface HostPathVariantResolution {
	/** The path to use: the first variant that exists, else the naive resolve. */
	path: string;
	/** Set when a VARIANT matched — `path` differs from the naive resolve. */
	variant?: "narrow-nbsp" | "nfd" | "curly-quote" | "nfd-curly-quote";
	/**
	 * The naive resolve did not exist and no variant did either. Distinct from
	 * "the naive resolve existed": callers that expect the file to be there use
	 * this to record a `path-variant-unresolved` degradation instead of
	 * returning silently (defect shape 10 — an empty result must say WHY).
	 */
	unresolved: boolean;
	/**
	 * Variant labels actually probed. Empty when the base resolve existed — and
	 * ALSO empty when every candidate collapsed onto the base path (a plain
	 * ASCII name with no quote and no AM/PM). Callers must therefore gate a
	 * degradation on `unresolved`, never on this being non-empty: the
	 * all-candidates-identical miss is a real miss, and gating it away is how
	 * the base-normalization cases went silent (#1655 review F1).
	 */
	triedVariants: string[];
}

/**
 * Mirror pi's read-path fallback ladder (#1655 item 5).
 *
 * pi does NOT open `resolve(cwd, input.path)`. `resolveReadPath`
 * (`@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:45-70`,
 * source `src/core/tools/path-utils.ts:52-83`) resolves, and when that path
 * does not exist it silently retries four unicode/spacing variants in this
 * exact order:
 *
 *   1. narrow no-break space before `AM.`/`PM.` (`tryMacOSScreenshotPath`)
 *   2. NFD normalization (`tryNFDVariant`) — macOS stores names decomposed
 *   3. U+0027 → U+2019 (`tryCurlyQuoteVariant`)
 *   4. NFD + curly quote combined
 *
 * Each candidate is used only when it DIFFERS from the resolved path and the
 * file exists; otherwise pi falls back to the resolved path. So the file pi
 * actually read can differ from what a naive `path.resolve` produces, and
 * pi-lens keyed its read guard, LSP touch, and dispatch off the naive form —
 * silently doing nothing for exactly those files.
 *
 * Order matters: it is pi's, so pi-lens picks the same file pi did when more
 * than one variant happens to exist.
 *
 * @param resolvedPath an already-resolved absolute path (the naive form)
 * @param fileExists injectable existence probe; defaults to `existsSync`
 */
export function resolveHostPathVariants(
	resolvedPath: string,
	fileExists: (candidate: string) => boolean = existsSync,
): HostPathVariantResolution {
	if (fileExists(resolvedPath)) {
		return { path: resolvedPath, unresolved: false, triedVariants: [] };
	}

	const nfd = resolvedPath.normalize("NFD");
	const candidates: Array<{
		variant: NonNullable<HostPathVariantResolution["variant"]>;
		candidate: string;
	}> = [
		{
			variant: "narrow-nbsp",
			candidate: resolvedPath.replace(
				/ (AM|PM)\./gi,
				`${NARROW_NO_BREAK_SPACE}$1.`,
			),
		},
		{ variant: "nfd", candidate: nfd },
		{
			variant: "curly-quote",
			candidate: resolvedPath.replaceAll("'", RIGHT_SINGLE_QUOTE),
		},
		{
			variant: "nfd-curly-quote",
			candidate: nfd.replaceAll("'", RIGHT_SINGLE_QUOTE),
		},
	];

	const triedVariants: string[] = [];
	for (const { variant, candidate } of candidates) {
		// pi skips a candidate identical to the resolved path, so pi-lens does
		// too — otherwise a no-op "variant" would be reported as a match.
		if (candidate === resolvedPath) continue;
		triedVariants.push(variant);
		if (fileExists(candidate)) {
			return { path: candidate, variant, unresolved: false, triedVariants };
		}
	}

	return { path: resolvedPath, unresolved: true, triedVariants };
}
