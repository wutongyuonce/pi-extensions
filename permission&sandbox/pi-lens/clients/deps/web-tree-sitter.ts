/**
 * Centralized LAZY accessor for `web-tree-sitter` (wasm — loaded on demand). See
 * ./typescript.ts for the rationale. Types are re-exported; the module itself is
 * fetched via `loadWebTreeSitter()`.
 *
 * Resolved to an absolute `file://` URL via `createRequire` before importing: an
 * absolute-path dynamic import works under pi's bundled host, a bare specifier
 * does not. The package `exports` map exposes only the `.` entry (no custom
 * subpath), so we resolve the bare package name and convert it to a `file://`
 * URL (a raw Windows path is not a valid import specifier); bare import kept as
 * a fallback.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type * from "web-tree-sitter";

export type WebTreeSitter = typeof import("web-tree-sitter");

const _require = createRequire(import.meta.url);

export function loadWebTreeSitter(): Promise<WebTreeSitter> {
	try {
		const entry = _require.resolve("web-tree-sitter");
		return import(pathToFileURL(entry).href) as Promise<WebTreeSitter>;
	} catch {
		return import("web-tree-sitter");
	}
}
