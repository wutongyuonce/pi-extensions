// Type declarations for web-tree-sitter-dir.mjs (untyped .mjs imported from
// .ts) — same pattern as scripts/lib/skills-predicate.d.mts.
//
// Three consumers: `clients/tree-sitter-client.ts`,
// `clients/install-diagnostics.ts` and `scripts/install-selftest.mjs` (the
// installed-host diagnostic, which is why the implementation lives under
// scripts/lib and not clients/ — see the module header).

export function isWebTreeSitterPackageDir(dir: string): boolean;

export function resolveWebTreeSitterPackageDir(deps: {
	/** The caller's own module resolver (`createRequire(...).resolve`). */
	resolve: (specifier: string) => string;
	/** pi-lens's installed package root. */
	packageRoot: () => string;
	/** The working directory. */
	cwd: () => string;
}): string | undefined;
