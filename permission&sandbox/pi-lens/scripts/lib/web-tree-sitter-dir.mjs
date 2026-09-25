/**
 * Where web-tree-sitter is installed — ONE ladder, for every caller that needs
 * the answer (#3409).
 *
 * Callers: `clients/tree-sitter-client.ts` (the grammar read path and the
 * lazy-fetch write target), `clients/install-diagnostics.ts` (the pasted
 * environment fingerprint) and `scripts/install-selftest.mjs` (the installed
 * host's own diagnostic). Each used to spell its own rungs, and the two that led
 * with a BARE specifier were unconditionally broken on the host pi ships: inside
 * a `bun build --compile` binary `require.resolve("web-tree-sitter")` throws
 * MODULE_NOT_FOUND while `require.resolve("web-tree-sitter/tree-sitter.wasm")` —
 * an explicit file subpath — still resolves.
 *
 * It lives in `scripts/lib/` rather than `clients/` because the installed
 * selftest is packaged (`files[]`) without `clients/`, and this is the house
 * pattern for logic a packaged .mjs script and the TypeScript runtime share
 * (`scripts/lib/skills-predicate.mjs`, `scripts/lib/process-scan.mjs`). It
 * imports nothing but `node:fs` and `node:path`, so it loads even on the hosts
 * whose broken dependency graph the selftest exists to report.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The package this module is about. Also the name its manifest must carry. */
const WEB_TREE_SITTER = "web-tree-sitter";

/**
 * The wasm the runtime loads, at the package root — where 0.25.10's `exports`
 * map puts it (`"./tree-sitter.wasm": "./tree-sitter.wasm"`). If a later release
 * moves it (#381's 0.26 migration), the two FALLBACK rungs below stop matching
 * and the resolver rungs, which ask Node for that same subpath, keep working;
 * this constant is then the one line to update.
 */
const RUNTIME_WASM = "tree-sitter.wasm";

/**
 * True when `dir` IS an installed web-tree-sitter package: its own manifest
 * names it, and the wasm the runtime loads is in it.
 *
 * Round 1 review of #3409 (R3418-1): the constructed rungs used to accept any
 * directory that merely EXISTED at `<base>/node_modules/web-tree-sitter`, so an
 * empty or foreign directory of that name became the runtime fetch's write
 * target and a downloaded grammar would land in an unrelated tree. Existence is
 * not identity. The manifest name is the identity; the wasm is what makes the
 * directory the right place to put grammars, since a grammar is only loadable by
 * the web-tree-sitter runtime sitting next to it (the ABI drift #1564 is about).
 */
export function isWebTreeSitterPackageDir(dir) {
	try {
		if (!fs.existsSync(path.join(dir, RUNTIME_WASM))) return false;
		const manifest = JSON.parse(
			fs.readFileSync(path.join(dir, "package.json"), "utf8"),
		);
		return manifest?.name === WEB_TREE_SITTER;
	} catch {
		return false;
	}
}

/**
 * The package directory owning `resolvedFile`: walk up until a directory passes
 * the identity check, or the filesystem root is reached. The walk exists because
 * an `exports` map may point into a subdirectory, so the file's own parent is
 * not necessarily the package; the identity check is what stops the walk, so a
 * resolver that answers outside any web-tree-sitter package yields nothing
 * rather than an unrelated ancestor.
 */
function packageDirOf(resolvedFile) {
	let dir = path.dirname(resolvedFile);
	for (;;) {
		if (isWebTreeSitterPackageDir(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * web-tree-sitter's installed package directory, or undefined.
 *
 * Rung order, most authoritative first:
 *  1. the `tree-sitter.wasm` SUBPATH, which resolves on a compiled host as well
 *     as a plain one. This is the rung that makes the non-core grammars
 *     fetchable there at all.
 *  2. the BARE specifier, for a future web-tree-sitter whose exports map no
 *     longer carries `./tree-sitter.wasm`.
 *  3. pi-lens's own package root, for the temp-dir compile layout (#20) where
 *     the resolver's context is a temp directory but the package root still has
 *     the right `node_modules`.
 *  4. the working directory, the pre-#3409 last resort.
 *
 * Rungs 1-2 are the resolver's answer and outrank the constructed guesses: the
 * grammars must come from the SAME package whose wasm the runtime loaded. Every
 * rung's candidate passes `isWebTreeSitterPackageDir` before it is returned.
 *
 * `resolve`, `packageRoot` and `cwd` are injected, never defaulted: the caller's
 * resolver context and package root are what differ on a compiled host, so they
 * must not be silently replaced by this module's — and a rung nothing can vary
 * is a rung no test can drive.
 */
export function resolveWebTreeSitterPackageDir(deps) {
	for (const specifier of [
		`${WEB_TREE_SITTER}/${RUNTIME_WASM}`,
		WEB_TREE_SITTER,
	]) {
		try {
			const dir = packageDirOf(deps.resolve(specifier));
			if (dir) return dir;
		} catch {
			/* next rung */
		}
	}
	for (const base of [deps.packageRoot, deps.cwd]) {
		try {
			const candidate = path.join(base(), "node_modules", WEB_TREE_SITTER);
			if (isWebTreeSitterPackageDir(candidate)) return candidate;
		} catch {
			/* next rung */
		}
	}
	return undefined;
}
