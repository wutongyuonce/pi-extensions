/**
 * `node:module` customization hook, registered by
 * `scripts/rekey-hook-await-exemptions.mjs` via `module.register()`.
 *
 * Node's own type stripping (unflagged since 22.18/23.6) lets a plain `node`
 * process `import()` a `.ts` file directly, but it does NOT resolve a `.js`
 * specifier to a sibling `.ts` file the way `tsc`'s `moduleResolution:
 * "nodenext"` (and vite/vitest) do. Every test-support module in this repo
 * is authored with that convention — `tests/support/hook-await-scan.ts`
 * imports `"./sweep-kit.js"`, and there is no compiled
 * `tests/support/sweep-kit.js` (only `clients/**` is built) — so a bare
 * `node` import of it fails with `Cannot find module '...sweep-kit.js'`.
 *
 * This hook is the minimal fix: when a relative `.js` specifier does not
 * resolve, retry it as `.ts`. It changes nothing else, and it is not needed
 * for any specifier that already resolves (a real compiled `clients/*.js`,
 * an `node:`-prefixed builtin, an npm package).
 */

export async function resolve(specifier, context, nextResolve) {
	if (
		specifier.endsWith(".js") &&
		(specifier.startsWith("./") || specifier.startsWith("../"))
	) {
		try {
			return await nextResolve(specifier, context);
		} catch (err) {
			if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
			return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
		}
	}
	return nextResolve(specifier, context);
}
