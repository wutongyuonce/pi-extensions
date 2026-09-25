/**
 * Per-rule path carve-outs (`ignores:` in a rule's own YAML, #965).
 *
 * ONE matcher, shared by every surface that decides whether a rule may fire on
 * a path: the NAPI ast-grep runner, the tree-sitter runner (`ignore_paths`),
 * and — since #3041 — the LSP output seam (`applyAuxiliarySuppressions`).
 *
 * #3041, measured against ast-grep 0.45.3: `ast-grep scan` applies a rule's
 * `ignores` globs during its own project walk, but `ast-grep lsp` publishes
 * per-document diagnostics WITHOUT applying them — the same rule on the same
 * file is filtered by the CLI and unfiltered over LSP. So every pi-lens path
 * that delivers ast-grep's LSP diagnostics has to apply the carve-out itself;
 * the runner-side matcher below is what it applies.
 */

import * as path from "node:path";
import { minimatch } from "../deps/minimatch.js";
import { buildEffectiveAstGrepCatalog } from "./ast-grep-catalog.js";
import { isWindowsPath, toPosix } from "../path-utils.js";

/**
 * True when `filePath` is carved out of a rule by one of its glob `patterns`.
 *
 * The glob is matched against `filePath` relative to `root`, forward-slashed.
 * Falls back to the absolute (slash-normalized) path when `filePath` isn't
 * under `root` (e.g. an out-of-tree temp file). Leaf-file patterns retain that
 * fallback for sinks such as a double-star logger leaf; directory carve-outs
 * ending in a slash plus double-star remain root-contained so a project's CLI
 * exemption cannot suppress a finding in an unrelated out-of-tree file.
 */
export function isRuleIgnoredForPath(
	filePath: string,
	root: string,
	patterns: readonly string[] | undefined,
): boolean {
	if (!patterns || patterns.length === 0) return false;
	const pathApi =
		isWindowsPath(root) || isWindowsPath(filePath) ? path.win32 : path.posix;
	const relative = pathApi.relative(root, filePath);
	const outsideRoot =
		relative !== "" &&
		(relative === ".." ||
			relative.startsWith(`..${pathApi.sep}`) ||
			pathApi.isAbsolute(relative));
	const displayPath = toPosix(outsideRoot ? filePath : relative);
	return patterns.some(
		(pattern) =>
			(!outsideRoot || !pattern.replaceAll("\\", "/").endsWith("/**")) &&
			minimatch(displayPath, pattern, { dot: true }),
	);
}

/**
 * Rule id → its `ignores` globs, for the effective ast-grep catalog at `root`.
 *
 * #3053: the catalog walk and its first-source-wins precedence used to be
 * reimplemented here; both this function and the NAPI runner now read
 * `buildEffectiveAstGrepCatalog` (clients/dispatch/ast-grep-catalog.ts), so
 * the LSP seam carves out exactly the paths the runner carves out by
 * construction rather than by two hand-aligned copies — see that module's
 * docstring for the precedence rule and the within-source-duplicate decision
 * this function inherits from it. The catalog's own loaders are cached, so
 * this is ~0.09 ms per call on pi-lens's own catalog (17 rules with
 * `ignores`, measured) — cheap enough to call per file rather than thread a
 * preloaded map through every sweep.
 *
 * Keyed by the EXACT rule id, matching the runner: a `-js` twin (e.g.
 * `no-console-except-error-js`) carries its own `ignores` in its own document,
 * so normalizing the suffix here would apply one document's carve-out to the
 * other's findings.
 */
export function loadRuleIgnorePatterns(
	root: string,
): ReadonlyMap<string, readonly string[]> {
	const patterns = new Map<string, readonly string[]>();
	for (const [id, { rule }] of buildEffectiveAstGrepCatalog(root)
		.effectiveRules) {
		if (rule.ignores?.length) patterns.set(id, rule.ignores);
	}
	return patterns;
}
