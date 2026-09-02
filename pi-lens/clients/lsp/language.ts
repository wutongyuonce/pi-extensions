import path from "node:path";
import {
	getLanguageId as getKindLanguageId,
	KIND_EXTENSIONS,
	SPECIAL_FILENAMES,
} from "../file-kinds.js";
import { getLspCapableKinds } from "../language-policy.js";

/**
 * Language ID Mappings for LSP
 *
 * Maps file extensions to LSP language identifiers.
 */

// Hand-curated ids, finer-grained than the per-kind registry id: one FileKind
// can span several language ids (jsts covers typescript/typescriptreact/vue,
// cxx covers c and cpp), and some servers want a spelling the registry doesn't
// use ("shellscript", not "shell"). These win over the derived fill-in below.
const CURATED_LANGUAGE_EXTENSIONS: Record<string, string> = {
	// JavaScript/TypeScript
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".svelte": "svelte",
	".vue": "vue",
	".astro": "astro",

	// Python
	".py": "python",
	".pyi": "python",

	// Go
	".go": "go",
	".mod": "go",
	".sum": "go",

	// Rust
	".rs": "rust",
	".ron": "rust",

	// C/C++
	".c": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".h": "c",
	".hpp": "cpp",
	".hh": "cpp",

	// Java
	".java": "java",

	// Kotlin
	".kt": "kotlin",
	".kts": "kotlin",

	// Ruby
	".rb": "ruby",
	".rake": "ruby",
	".gemspec": "ruby",
	".ru": "ruby",

	// PHP
	".php": "php",

	// C#
	".cs": "csharp",

	// F#
	".fs": "fsharp",
	".fsi": "fsharp",
	".fsx": "fsharp",

	// Swift
	".swift": "swift",

	// Dart
	".dart": "dart",

	// Lua
	".lua": "lua",

	// Shell
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".fish": "fish",

	// CMake
	".cmake": "cmake",

	// JSON/YAML
	".json": "json",
	".jsonc": "jsonc",
	".yaml": "yaml",
	".yml": "yaml",

	// Markdown
	".md": "markdown",
	".mdx": "markdown",

	// CSS
	".css": "css",
	".scss": "scss",
	".sass": "sass",
	".less": "less",

	// HTML
	".html": "html",
	".htm": "html",

	// SQL
	".sql": "sql",

	// Docker
	".dockerfile": "dockerfile",

	// Terraform
	".tf": "terraform",
	".tfvars": "terraform",

	// Nix
	".nix": "nix",

	// Elixir
	".ex": "elixir",
	".exs": "elixir",

	// Haskell
	".hs": "haskell",
	".lhs": "haskell",

	// OCaml
	".ml": "ocaml",
	".mli": "ocaml",

	// Zig
	".zig": "zig",
	".zon": "zig",

	// Gleam
	".gleam": "gleam",

	// Clojure
	".clj": "clojure",
	".cljs": "clojure",
	".cljc": "clojure",
	".edn": "clojure",

	// Scala
	".scala": "scala",
	".sc": "scala",

	// R
	".r": "r",
	".R": "r",

	// Julia
	".jl": "julia",

	// Perl
	".pl": "perl",
	".pm": "perl",

	// Erlang
	".erl": "erlang",
	".hrl": "erlang",

	// Fortran
	".f": "fortran",
	".f90": "fortran",
	".f95": "fortran",

	// COBOL
	".cob": "cobol",
	".cbl": "cobol",

	// Pascal
	".pas": "pascal",
	".pp": "pascal",

	// Ada
	".adb": "ada",
	".ads": "ada",

	// VHDL/Verilog
	".vhd": "vhdl",
	".vhdl": "vhdl",
	".v": "verilog",
	".sv": "systemverilog",

	// GraphQL
	".graphql": "graphql",
	".gql": "graphql",

	// Protocol Buffers
	".proto": "proto",

	// TOML
	".toml": "toml",

	// Prisma
	".prisma": "prisma",

	// Typst
	".typ": "typst",
	".typc": "typst",
} as const;

/**
 * Curated ids plus a derived fill-in for every extension an lspCapable kind
 * registers. Before #1545 this table was hand-maintained alone and had drifted:
 * powershell had no entry at all and cxx covered a third of its extensions, so
 * `didOpen` announced those files as "plaintext". Tolerance for that varies by
 * server — json/yaml/clangd answer the same either way, a DocumentSelector
 * server may not handle the document at all — so the id is sent correctly
 * rather than relied on being ignored. A newly registered language now reaches
 * this seam by being lspCapable.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = (() => {
	const map: Record<string, string> = { ...CURATED_LANGUAGE_EXTENSIONS };
	for (const kind of getLspCapableKinds()) {
		for (const extension of KIND_EXTENSIONS[kind]) {
			map[extension] ??= getKindLanguageId(kind);
		}
	}
	return map;
})();

/**
 * file-kinds.ts's basename classifier (Makefile, Dockerfile.<suffix>,
 * CMakeLists.txt, …) matches by regex, not literal filename, so it can't be
 * flattened into LANGUAGE_EXTENSIONS' literal-key map. Derived from
 * SPECIAL_FILENAMES — the same single source of truth detectFileKind() uses —
 * filtered to lspCapable kinds so a basename pattern that classifies into an
 * lspCapable kind always resolves a language id here too (#1594).
 */
const BASENAME_LANGUAGE_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	languageId: string;
}> = (() => {
	const lspCapableKinds = new Set(getLspCapableKinds());
	return SPECIAL_FILENAMES.filter(({ kind }) => lspCapableKinds.has(kind)).map(
		({ pattern, kind }) => ({
			pattern,
			languageId: getKindLanguageId(kind),
		}),
	);
})();

function getBasenameLanguageId(base: string): string | undefined {
	return BASENAME_LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(base))
		?.languageId;
}

/**
 * Get language ID for a file path
 */
export function getLanguageId(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (ext && LANGUAGE_EXTENSIONS[ext]) {
		return LANGUAGE_EXTENSIONS[ext];
	}

	const base = path.basename(filePath);
	return (
		LANGUAGE_EXTENSIONS[base] ??
		LANGUAGE_EXTENSIONS[base.toLowerCase()] ??
		getBasenameLanguageId(base)
	);
}

/**
 * Get all extensions for a language ID
 */
export function getExtensionsForLanguage(languageId: string): string[] {
	return Object.entries(LANGUAGE_EXTENSIONS)
		.filter(([, id]) => id === languageId)
		.map(([ext]) => ext);
}
