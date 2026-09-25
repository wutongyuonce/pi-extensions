import * as fs from "node:fs";
import * as os from "node:os";
import { BoundedLruCache } from "../bounded-cache.js";
import * as path from "node:path";
import {
	findGoverningTsconfigDir,
	getDirectoryMarkers,
	registerWorkspaceTopologyReset,
} from "../workspace-topology.js";

export interface TsconfigPathMatcher {
	pattern: string;
	prefix: string;
	suffix: string;
	targets: string[];
}

interface TsconfigJson {
	extends?: string;
	references?: Array<{ path?: string }>;
	include?: string[];
	compilerOptions?: {
		baseUrl?: string;
		paths?: Record<string, string[]>;
		rootDir?: string;
	};
}

interface ParsedConfig {
	baseUrl: string;
	paths?: Record<string, string[]>;
	rootDir?: string;
	include?: string[];
	references: string[];
}

const cache = new BoundedLruCache<string, TsconfigPathMatcher[]>(64);
const referencesCache = new BoundedLruCache<string, Map<string, string>>(64);
registerWorkspaceTopologyReset(() => {
	cache.clear();
	referencesCache.clear();
});

/** Strip JSONC comments and trailing commas without touching string contents. */
function parseJsonc(content: string): TsconfigJson {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		const next = content[i + 1];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
		} else if (char === "/" && next === "/") {
			while (i < content.length && content[i] !== "\n") i++;
			output += "\n";
		} else if (char === "/" && next === "*") {
			i += 2;
			while (
				i < content.length &&
				!(content[i] === "*" && content[i + 1] === "/")
			)
				i++;
			i++;
		} else {
			output += char;
		}
	}
	return JSON.parse(output.replace(/,\s*([}\]])/g, "$1")) as TsconfigJson;
}

function configSignature(configPath: string): string {
	try {
		const stat = fs.statSync(configPath);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

function configDependencyPaths(configPath: string): string[] {
	const paths = new Set<string>();
	const visit = (currentPath: string): void => {
		const normalized = path.resolve(currentPath);
		if (paths.has(normalized)) return;
		paths.add(normalized);
		let json: TsconfigJson;
		try {
			json = parseJsonc(fs.readFileSync(normalized, "utf8"));
		} catch {
			return;
		}
		if (typeof json.extends === "string") {
			const parent = resolveExtends(normalized, json.extends);
			if (parent) visit(parent);
		}
		for (const reference of json.references ?? []) {
			if (typeof reference?.path !== "string") continue;
			const referenced = resolveReferenceConfig(normalized, reference.path);
			if (referenced) visit(referenced);
		}
	};
	visit(configPath);
	return [...paths].sort((a, b) => a.localeCompare(b));
}

function dependencySignature(configPath: string): string {
	return configDependencyPaths(configPath)
		.map((dependency) => `${dependency}:${configSignature(dependency)}`)
		.join("|");
}

function resolveExtends(configPath: string, value: string): string | undefined {
	if (!value.startsWith(".")) return undefined;
	const resolved = path.resolve(path.dirname(configPath), value);
	return resolved.toLowerCase().endsWith(".json")
		? resolved
		: `${resolved}.json`;
}

function readConfig(
	configPath: string,
	seen: Set<string>,
): ParsedConfig | undefined {
	const normalized = path.resolve(configPath);
	if (seen.has(normalized)) return undefined;
	seen.add(normalized);
	let json: TsconfigJson;
	try {
		json = parseJsonc(fs.readFileSync(normalized, "utf8")) as TsconfigJson;
	} catch {
		return undefined;
	}
	let inherited: ParsedConfig | undefined;
	if (typeof json.extends === "string") {
		const parentPath = resolveExtends(normalized, json.extends);
		if (parentPath) inherited = readConfig(parentPath, seen);
	}
	const options = json.compilerOptions;
	const baseUrl =
		typeof options?.baseUrl === "string"
			? path.resolve(path.dirname(normalized), options.baseUrl)
			: (inherited?.baseUrl ?? path.dirname(normalized));
	const paths =
		options?.paths && typeof options.paths === "object"
			? Object.fromEntries(
					Object.entries(options.paths).map(([pattern, targets]) => [
						pattern,
						Array.isArray(targets)
							? targets.map((target) => path.resolve(baseUrl, target))
							: targets,
					]),
				)
			: inherited?.paths;
	const rootDir =
		typeof options?.rootDir === "string"
			? path.resolve(path.dirname(normalized), options.rootDir)
			: inherited?.rootDir;
	const include = Array.isArray(json.include)
		? json.include.filter((value): value is string => typeof value === "string")
		: inherited?.include;
	const references = Array.isArray(json.references)
		? json.references
				.map((reference) => reference?.path)
				.filter(
					(value): value is string =>
						typeof value === "string" && value.startsWith("."),
				)
		: [];
	return { baseUrl, paths, rootDir, include, references };
}

function resolveReferenceConfig(
	configPath: string,
	value: string,
): string | undefined {
	const target = path.resolve(path.dirname(configPath), value);
	try {
		if (fs.statSync(target).isDirectory()) {
			return getDirectoryMarkers(target).tsconfigPath;
		}
		if (fs.statSync(target).isFile()) return target;
	} catch {
		return undefined;
	}
	return undefined;
}

function includeRoot(configDir: string, pattern: string): string | undefined {
	const wildcard = pattern.search(/[*?]/);
	const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
	const trimmed = prefix.replace(/[\\/]+$/, "");
	if (!trimmed) return undefined;
	const resolved = path.resolve(configDir, trimmed);
	return path.extname(resolved) ? path.dirname(resolved) : resolved;
}

function firstSourceEntry(
	configPath: string,
	parsed: ParsedConfig,
): string | undefined {
	const configDir = path.dirname(configPath);
	const roots = [
		...(parsed.rootDir ? [parsed.rootDir] : []),
		...(parsed.include ?? [])
			.map((pattern) => includeRoot(configDir, pattern))
			.filter((value): value is string => value !== undefined),
	];
	const candidates = [
		...roots.flatMap((root) => [
			path.join(root, "index.ts"),
			path.join(root, "index.tsx"),
		]),
		path.join(configDir, "src", "index.ts"),
		path.join(configDir, "src", "index.tsx"),
		path.join(configDir, "index.ts"),
		path.join(configDir, "index.tsx"),
	];
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next conventional entry.
		}
	}
	return undefined;
}

function collectReferencedProjects(
	configPath: string,
	result: Map<string, string>,
	visited: Set<string>,
): void {
	const normalized = path.resolve(configPath);
	if (visited.has(normalized)) return;
	visited.add(normalized);
	const parsed = readConfig(normalized, new Set());
	if (!parsed) return;
	for (const reference of parsed.references) {
		const referencedConfig = resolveReferenceConfig(normalized, reference);
		if (!referencedConfig) continue;
		const referenced = readConfig(referencedConfig, new Set());
		if (referenced) {
			const packageJsonPath = getDirectoryMarkers(
				path.dirname(referencedConfig),
			).packageJsonPath;
			const entry = firstSourceEntry(referencedConfig, referenced);
			if (packageJsonPath && entry) {
				try {
					const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
						name?: unknown;
					};
					if (typeof pkg.name === "string" && !result.has(pkg.name)) {
						result.set(pkg.name, entry);
					}
				} catch {
					// An unreadable adjacent package.json does not define a mapping.
				}
			}
		}
		collectReferencedProjects(referencedConfig, result, visited);
	}
}

/** Find and parse the nearest governing tsconfig, cached per importer directory. */
export function parseTsconfigPaths(
	cwd: string,
	homeDir = os.homedir(),
): TsconfigPathMatcher[] {
	const normalizedCwd = path.resolve(cwd);
	const configDir = findGoverningTsconfigDir(normalizedCwd, homeDir);
	const configPath = configDir ? path.join(configDir, "tsconfig.json") : "";
	const signature = configPath ? dependencySignature(configPath) : "missing";
	const key = `${normalizedCwd}|${configPath}|${signature}`;
	const cached = cache.get(key);
	if (cached) return cached;
	// Home-guarding is enforced inside findGoverningTsconfigDir's walk itself
	// (via workspace-topology's shared isAtOrAboveHomeDir ceiling), so a hit
	// here is never at/above homeDir.
	if (!configDir) {
		cache.set(key, []);
		return [];
	}
	const parsed = readConfig(path.join(configDir, "tsconfig.json"), new Set());
	const matchers = Object.entries(parsed?.paths ?? {})
		.filter(
			(entry): entry is [string, string[]] =>
				Array.isArray(entry[1]) &&
				entry[1].every((target) => typeof target === "string"),
		)
		.map(([pattern, targets]) => {
			const star = pattern.indexOf("*");
			return {
				pattern,
				prefix: star === -1 ? pattern : pattern.slice(0, star),
				suffix: star === -1 ? "" : pattern.slice(star + 1),
				targets,
			};
		})
		.sort((a, b) => b.prefix.length - a.prefix.length);
	cache.set(key, matchers);
	return matchers;
}

/** Apply the longest matching paths pattern and substitute its single `*`. */
export function aliasedImportTargets(
	specifier: string,
	importerDir: string,
): string[] {
	for (const matcher of parseTsconfigPaths(importerDir)) {
		if (
			!specifier.startsWith(matcher.prefix) ||
			!specifier.endsWith(matcher.suffix)
		)
			continue;
		const wildcard = specifier.slice(
			matcher.prefix.length,
			specifier.length - matcher.suffix.length,
		);
		if (!matcher.pattern.includes("*") && wildcard) continue;
		return matcher.targets.map((target) => target.replaceAll("*", wildcard));
	}
	return [];
}

/** Resolve an exact package-name import through the governing config's project references. */
export function referencedProjectImportTarget(
	specifier: string,
	importerDir: string,
): string | undefined {
	const normalizedImporterDir = path.resolve(importerDir);
	const governingDir = findGoverningTsconfigDir(normalizedImporterDir);
	const governingPath = governingDir
		? path.join(governingDir, "tsconfig.json")
		: "";
	const key = `${normalizedImporterDir}|${governingPath}|${governingPath ? dependencySignature(governingPath) : "missing"}`;
	let projects = referencesCache.get(key);
	if (!projects) {
		projects = new Map();
		const configDir = governingDir;
		if (configDir) {
			collectReferencedProjects(
				path.join(configDir, "tsconfig.json"),
				projects,
				new Set(),
			);
		}
		referencesCache.set(key, projects);
	}
	return projects.get(specifier);
}

export function clearTsconfigPathsCache(): void {
	cache.clear();
	referencesCache.clear();
}
