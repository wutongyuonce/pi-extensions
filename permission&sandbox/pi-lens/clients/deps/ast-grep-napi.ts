/**
 * Centralized LAZY accessor for `@ast-grep/napi` (a native addon — loaded on
 * demand, never at module-eval). See ./typescript.ts for the rationale.
 * Types are re-exported; the module itself is fetched via `loadAstGrepNapi()`.
 *
 * Resolved to an absolute `file://` URL via `createRequire` before importing: an
 * absolute-path dynamic import works under pi's bundled host, a bare specifier
 * does not. The path is converted to a `file://` URL (a raw Windows path is not
 * a valid import specifier); bare import kept as a fallback.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type * from "@ast-grep/napi";

export type AstGrepNapi = typeof import("@ast-grep/napi");

const _require = createRequire(import.meta.url);

export function loadAstGrepNapi(): Promise<AstGrepNapi> {
	try {
		const entry = _require.resolve("@ast-grep/napi");
		return import(pathToFileURL(entry).href) as Promise<AstGrepNapi>;
	} catch {
		return import("@ast-grep/napi");
	}
}
