import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Map .js specifiers to same-dir .ts files so source modules (which import
 * with .js extensions for pi's loader) resolve under node's native TS type
 * stripping. No shortCircuit: let --experimental-strip-types handle it,
 * otherwise type-only imports would SyntaxError.
 */
export async function resolve(specifier, context, nextResolve) {
	if (
		specifier.startsWith(".") &&
		specifier.endsWith(".js") &&
		context.parentURL
	) {
		const parentDir = dirname(fileURLToPath(context.parentURL));
		const tsPath = join(parentDir, specifier.replace(/\.js$/, ".ts"));
		if (existsSync(tsPath)) {
			return nextResolve(pathToFileURL(tsPath).href, context);
		}
	}
	return nextResolve(specifier, context);
}
