/**
 * Project-level `.pi-lens.json` config loader.
 *
 * Reads an optional `.pi-lens.json` (or `pi-lens.json`) at the project root and
 * surfaces the fields the rest of pi-lens honors:
 *
 *   - `ignore` — gitignore-style glob patterns added to every scan (LSP walk,
 *     fact-rules, tree-sitter, jscpd, knip, review graph, source-filter). Wired
 *     into `getProjectIgnoreMatcher` in `file-utils.ts` via the existing
 *     `createProjectIgnoreMatcher(rootDir, extraPatterns)` extension point.
 *
 *   - `rules` — per-rule threshold overrides. Currently honored:
 *       rules["high-complexity"].threshold — cyclomatic complexity (default 15)
 *       rules["high-fan-out"].threshold   — distinct-function calls (default 20)
 *
 *   - `maxProjectFiles` — the base project-size scale knob (#776). Read by
 *     `clients/project-scale.ts`'s `getProjectScaleBase`, which derives the
 *     five subsystem size budgets (project-diagnostics scanner, review graph,
 *     startup scan, jscpd, word index) as documented ratios of this value.
 *
 *   - `reviewGraph.maxFiles` — explicit review-graph file-budget override
 *     (#775 R2), for monorepos that want a bigger graph than
 *     `project-scale.ts`'s adaptive taper would derive from
 *     `maxProjectFiles` alone. Tolerantly parsed (numeric strings coerce via
 *     `toPositiveFinite`, same as `maxProjectFiles`) and clamped to
 *     `[100, 20_000]` — a value outside that range is silently clamped
 *     rather than rejected (still an explicit, deliberate opt-in; only a
 *     non-numeric/non-positive value warns and is dropped). Read by
 *     `getReviewGraphMaxFilesDerived`, where it takes precedence over the
 *     taper (but the subsystem's own PRE-EXISTING
 *     `PI_LENS_REVIEW_GRAPH_MAX_FILES` env override still wins outright over
 *     both, unchanged).
 *
 *   - `format.enabled`, `autofix.enabled`, and
 *     `actionableWarnings.autoFix.enabled` — project-owned mutation controls.
 *     These can disable pi-lens writes while leaving diagnostics enabled.
 *
 * The file is loaded once per `(path, mtimeMs)` and cached — editing the file
 * invalidates the cache so the next access sees the new values without
 * restarting pi. Discovery is cached by starting directory and validated by the
 * cached directory mtimes plus the config-file mtime, so hot paths do not repeat
 * candidate-file probes on every dispatch.
 *
 * The loader walks up from the starting directory until it finds a config file
 * (mirroring `lsp/config.ts`'s `loadLSPConfig` so project-monorepos with a
 * `.pi-lens.json` at the repo root work without per-subdir configs).
 *
 * A malformed file is treated as "no config" and logged once — we never want a
 * stray syntax error in user-edited JSON to break diagnostics.
 *
 * `findPiLensConfigInDir` / `loadPiLensConfigInDir` are the per-directory
 * (no upward walk) counterparts used by `file-utils.ts`'s
 * `getProjectIgnoreMatcher` to layer NESTED `.pi-lens.json` `ignore` fields
 * the same way nested `.gitignore`s are already layered (#783): every
 * ancestor directory between the git root and a scanned file is checked for
 * its own config file, so a package-local `.pi-lens.json`'s `ignore`
 * patterns apply to files inside that package, in addition to (and with
 * higher precedence than) the root config's `ignore` patterns.
 */
import { logExtension } from "./extension-log.js";
import { notifyUserDegradation } from "./user-notify.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toPositiveFinite } from "./env-utils.js";
import {
	assignFlagConfigSection,
	flagConfigSectionKeys,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	type LensFlagSpec,
	PROJECT_FOREIGN_CONFIG_NAMESPACES,
	PROJECT_SCOPED_LENS_FLAGS,
	readFlagConfigValue,
} from "./lens-flag-registry.js";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.js";
import { findPiLensConfigMarkerInDir } from "./workspace-topology.js";

const PROJECT_CONFIG_BASENAMES = [".pi-lens.json", "pi-lens.json"];

/**
 * The project loader's OWN recognized top-level keys — pi-lens-native sections,
 * whether parsed here into typed fields (`ignore`, `rules`, `maxProjectFiles`,
 * `reviewGraph`) or read off `PiLensProjectConfig.raw` by another pi-lens
 * consumer (`trivy`, read via `.raw` in `trivy-client.ts`). The project-scoped
 * flag sections (`format`, `autofix`, `actionableWarnings`) are NOT listed here;
 * they are derived from `PROJECT_SCOPED_LENS_FLAGS` so the registry stays the
 * single source of truth (#883). Foreign (non-pi-lens) namespaces the shared
 * file also carries live in `PROJECT_FOREIGN_CONFIG_NAMESPACES` beside the
 * registry.
 */
const PROJECT_OWN_CONFIG_KEYS = [
	"ignore",
	"rules",
	"maxProjectFiles",
	"reviewGraph",
	"trivy",
	// `helm.renderValidation.enabled` — the opt-in for rendered-manifest
	// validation, read via `.raw` in the helm-render runner (#1283).
	"helm",
] as const;

export interface PiLensProjectRuleConfig {
	/** Optional override for the rule's primary numeric threshold. */
	threshold?: number;
	/**
	 * Project-level disable list — rule ids whose diagnostics the project's
	 * `.pi-lens.json` deliberately turns off. Output-only filtering (the
	 * diagnostics are still recorded: widget state, baseline, and dispatch
	 * dedup see them), so a project's own policy never widens the trusted
	 * surface area beyond what the user actually sees. Matching is PROJECT-
	 * WIDE: the `<id>` key this list lives under is a grouping label only, not
	 * a filter scope — every `disable` list across every `rules.<key>` entry
	 * is unioned before matching. Disable is stronger than `select` (below) —
	 * a rule on both lists is dropped.
	 */
	disable?: string[];
	/**
	 * Project-level allowlist — when the UNION of `select` lists across every
	 * `rules.<key>` entry is non-empty, ONLY the rule ids in that union
	 * survive filtering; everything else is dropped, project-wide (an absent
	 * or empty union everywhere is "no restriction"). Like `disable`, the
	 * `<id>` key this list lives under does not scope which rules it can
	 * match. A rule on both `select` and `disable` is dropped (disable wins —
	 * explicit exclusion trumps explicit inclusion).
	 */
	select?: string[];
}

export interface PiLensProjectMutationConfig {
	/** Whether this mutation path is enabled for the project. */
	enabled?: boolean;
}

export interface PiLensProjectReviewGraphConfig {
	/**
	 * Explicit review-graph file budget, clamped to `[100, 20_000]`.
	 * `undefined` means "derive from `maxProjectFiles` via the taper".
	 */
	maxFiles?: number;
}

/** Clamp bounds for `reviewGraph.maxFiles` — see the field's doc comment above. */
const REVIEW_GRAPH_MAX_FILES_MIN = 100;
const REVIEW_GRAPH_MAX_FILES_MAX = 20_000;

export interface PiLensProjectConfig {
	/** gitignore-style glob patterns added to every diagnostic scan. */
	ignore: string[];
	/** Per-rule threshold overrides; missing keys mean "use hardcoded default". */
	rules: Record<string, PiLensProjectRuleConfig>;
	/** Whether automatic formatting is enabled after write/edit tool calls. */
	format?: PiLensProjectMutationConfig;
	/** Whether the pipeline may apply deterministic linter fixes. */
	autofix?: PiLensProjectMutationConfig;
	/** Project-level controls for actionable-warning behavior. */
	actionableWarnings?: {
		/** Whether conservative warning fixes may run at agent_end. */
		autoFix?: PiLensProjectMutationConfig;
	};
	/**
	 * Base project-size scale knob (#776) — see `clients/project-scale.ts`.
	 * `undefined` means "use the env override / default chain".
	 */
	maxProjectFiles: number | undefined;
	/**
	 * Review-graph-specific overrides (#775 R2). `undefined` (the whole
	 * object, or just `maxFiles`) means "use the adaptive taper" — see
	 * `clients/project-scale.ts`'s `getReviewGraphMaxFilesDerived`.
	 */
	reviewGraph?: PiLensProjectReviewGraphConfig;
	/** The parsed JSON as-is, for forward-compat consumers. */
	raw: unknown;
	/** Absolute path of the config file that was loaded, or undefined if none. */
	configPath: string | undefined;
}

export const EMPTY_PROJECT_CONFIG: PiLensProjectConfig = {
	ignore: [],
	rules: {},
	maxProjectFiles: undefined,
	reviewGraph: undefined,
	raw: undefined,
	configPath: undefined,
};

interface CacheEntry {
	mtimeMs: number;
	/**
	 * Byte size at parse time (#1105). Reuse requires BOTH mtime and size to
	 * match — size is the free second axis (the same stat already read it) that
	 * catches an mtime-preserving, length-changing in-place edit (git checkout,
	 * same-second rewrite) that mtime alone would replay stale. Residual (same
	 * mtime AND same size) matches the review-graph `size:mtimeMs` accepted
	 * residual; closing it would need a content hash on every gate check — the
	 * hot-path cost the word-index #1105 fix deliberately declined.
	 */
	size: number;
	config: PiLensProjectConfig;
}

interface DiscoveryCacheEntry {
	info: PiLensProjectConfigFileInfo | undefined;
	dirMtimes: Array<{ dir: string; mtimeMs: number }>;
}

/** Cache by absolute config path; we read each candidate's mtime before reuse. */
const configCache = new Map<string, CacheEntry>();
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const warnedInvalidConfigs = new Set<string>();

/**
 * Walk up from `startDir` looking for a `.pi-lens.json` or `pi-lens.json`.
 * Returns the parsed config, or an empty config if none was found.
 */
export function loadPiLensProjectConfig(
	startDir: string,
	preloadedInfo = findPiLensProjectConfig(startDir),
): PiLensProjectConfig {
	const configInfo = preloadedInfo;
	if (!configInfo) return EMPTY_PROJECT_CONFIG;

	const cached = configCache.get(configInfo.path);
	if (
		cached &&
		cached.mtimeMs === configInfo.mtimeMs &&
		cached.size === configInfo.size
	) {
		return cached.config;
	}

	const config = parseConfigFile(configInfo.path);
	configCache.set(configInfo.path, {
		mtimeMs: configInfo.mtimeMs,
		size: configInfo.size,
		config,
	});
	return config;
}

/** For tests + callers that need to force a re-read (e.g. config-watcher hooks). */
export function resetProjectLensConfigCache(): void {
	configCache.clear();
	discoveryCache.clear();
	warnedInvalidConfigs.clear();
}

export interface PiLensProjectConfigFileInfo {
	path: string;
	dir: string;
	mtimeMs: number;
	/** Byte size at stat time — the #1105 second freshness axis (see CacheEntry). */
	size: number;
}

/**
 * Look for a `.pi-lens.json`/`pi-lens.json` directly IN `dir` — no upward
 * walk. Used to layer nested per-package configs (#783) the same way
 * `file-utils.ts` layers nested `.gitignore`s: each ancestor directory
 * between the git root and a target file is checked for its OWN config
 * file, independent of whatever config `loadPiLensProjectConfig`'s upward
 * walk would find starting from `dir`.
 *
 * Sourced from the shared workspace-topology marker index (#806) — one
 * `readdir` pass per directory visit collects this marker alongside
 * `tsconfig.json`/workspace-manifest markers other consumers need for the
 * SAME directory, instead of each subsystem re-probing it independently.
 */
export function findPiLensConfigInDir(
	dir: string,
): PiLensProjectConfigFileInfo | undefined {
	const marker = findPiLensConfigMarkerInDir(dir);
	if (!marker) return undefined;
	return {
		path: marker.path,
		dir: marker.dir,
		mtimeMs: marker.mtimeMs,
		size: marker.size,
	};
}

export interface NestedProjectMutationValue {
	value: boolean;
	dir: string;
}

/**
 * Find the closest config, between an edited file and the project root, that
 * explicitly defines one mutation flag. The walk uses the shared primitive
 * and refuses to inspect HOME or any ancestor of HOME.
 */
export function findNestedProjectMutationValue(
	spec: LensFlagSpec,
	editedFilePath: string,
	projectRoot: string,
	homeDir = os.homedir(),
): NestedProjectMutationValue | undefined {
	const root = path.resolve(projectRoot);
	const start = path.dirname(path.resolve(editedFilePath));
	for (const dir of walkUpDirs(start)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		const rel = path.relative(root, dir);
		if (rel.startsWith("..") || path.isAbsolute(rel)) break;
		const config = loadPiLensConfigInDir(dir);
		const enabled = readFlagConfigValue(config, spec.configKey);
		if (enabled !== undefined) return { value: enabled, dir };
		if (dir === root) break;
	}
	return undefined;
}

/**
 * Load the `.pi-lens.json`/`pi-lens.json` directly IN `dir` (no upward
 * walk) — the per-directory counterpart to `loadPiLensProjectConfig`'s
 * upward-walking discovery. Shares `configCache` (keyed by absolute config
 * path + mtime), so a directory whose config was already loaded via the
 * upward-walk path (e.g. the git root itself) is not re-read here.
 */
export function loadPiLensConfigInDir(dir: string): PiLensProjectConfig {
	const info = findPiLensConfigInDir(dir);
	if (!info) return EMPTY_PROJECT_CONFIG;

	const cached = configCache.get(info.path);
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
		return cached.config;
	}

	const config = parseConfigFile(info.path);
	configCache.set(info.path, {
		mtimeMs: info.mtimeMs,
		size: info.size,
		config,
	});
	return config;
}

export function findPiLensProjectConfig(
	startDir: string,
): PiLensProjectConfigFileInfo | undefined {
	const cacheKey = path.resolve(startDir);
	const cached = discoveryCache.get(cacheKey);
	if (cached && discoveryCacheStillFresh(cached)) {
		if (!cached.info) return undefined;
		const stat = safeFileStat(cached.info.path);
		if (stat?.isFile())
			return { ...cached.info, mtimeMs: stat.mtimeMs, size: stat.size };
	}

	const discovered = discoverPiLensProjectConfig(cacheKey);
	discoveryCache.set(cacheKey, discovered);
	return discovered.info;
}

function safeFileStat(filePath: string): fs.Stats | undefined {
	try {
		return fs.statSync(filePath);
	} catch {
		return undefined;
	}
}

function safeDirMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return -1;
	}
}

function discoveryCacheStillFresh(entry: DiscoveryCacheEntry): boolean {
	return entry.dirMtimes.every(
		(cached) => safeDirMtimeMs(cached.dir) === cached.mtimeMs,
	);
}

function discoverPiLensProjectConfig(startDir: string): DiscoveryCacheEntry {
	const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
	for (const dir of walkUpDirs(startDir)) {
		dirMtimes.push({ dir, mtimeMs: safeDirMtimeMs(dir) });
		for (const name of PROJECT_CONFIG_BASENAMES) {
			const candidate = path.join(dir, name);
			const stat = safeFileStat(candidate);
			if (stat?.isFile()) {
				return {
					info: {
						path: candidate,
						dir,
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					},
					dirMtimes,
				};
			}
		}
	}
	return { info: undefined, dirMtimes };
}

function warnInvalidConfigOnce(configPath: string, reason: string): void {
	const key = `${configPath}:${reason}`;
	if (warnedInvalidConfigs.has(key)) return;
	warnedInvalidConfigs.add(key);
	const message = `ignoring invalid project config ${configPath}: ${reason}`;
	logExtension({
		subsystem: "project-lens-config",
		level: "warn",
		message,
		metadata: { configPath, reason },
	});
	// HUMAN-audience too: the user's own `.pi-lens.json` is being ignored.
	notifyUserDegradation(`pi-lens: ${message}`);
}

function parseRulePolicyList(
	configPath: string,
	ruleId: string,
	key: "disable" | "select",
	value: unknown,
): { list: string[]; invalid: boolean } {
	if (!Array.isArray(value)) {
		warnInvalidConfigOnce(
			configPath,
			`rules.${ruleId}.${key} must be an array of strings`,
		);
		return { list: [], invalid: true };
	}
	const list: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length > 0) list.push(trimmed);
	}
	if (list.length === 0) {
		// #1087: an explicitly empty array (`"disable": []`) is a well-formed
		// no-op, not an error — don't warn. Only warn when the array HAD entries
		// but none were usable strings (all blank / non-string), which is a real
		// authoring mistake that must not fail silently.
		if (value.length > 0) {
			warnInvalidConfigOnce(
				configPath,
				`rules.${ruleId}.${key} must contain at least one non-empty string`,
			);
			return { list: [], invalid: true };
		}
		return { list: [], invalid: false };
	}
	return { list, invalid: false };
}

function parseConfigFile(configPath: string): PiLensProjectConfig {
	let raw: unknown;
	try {
		const text = fs.readFileSync(configPath, "utf-8");
		raw = JSON.parse(text);
	} catch (error) {
		warnInvalidConfigOnce(
			configPath,
			error instanceof Error ? error.message : "failed to parse JSON",
		);
		return EMPTY_PROJECT_CONFIG;
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnInvalidConfigOnce(configPath, "top-level value must be an object");
		return EMPTY_PROJECT_CONFIG;
	}

	const obj = raw as Record<string, unknown>;

	const ignore = Array.isArray(obj.ignore)
		? obj.ignore.filter((p): p is string => typeof p === "string")
		: [];
	const mutations: Record<string, unknown> = {};
	for (const spec of PROJECT_SCOPED_LENS_FLAGS) {
		assignFlagConfigSection(obj, mutations, spec.configKey, (reason) =>
			warnInvalidConfigOnce(configPath, reason),
		);
	}

	const rules: Record<string, PiLensProjectRuleConfig> = {};
	if (obj.rules && typeof obj.rules === "object" && !Array.isArray(obj.rules)) {
		const rawRules = obj.rules as Record<string, unknown>;
		for (const [ruleId, ruleCfg] of Object.entries(rawRules)) {
			// #444's own example writes the lists directly under `rules` (`rules.
			// disable`), which lands here as an array and would otherwise be
			// dropped without a word — the one shape a user is most likely to try.
			if (!ruleCfg || typeof ruleCfg !== "object" || Array.isArray(ruleCfg)) {
				warnInvalidConfigOnce(
					configPath,
					`rules.${ruleId} must be an object with threshold, disable, or select; ignored`,
				);
				continue;
			}
			const r = ruleCfg as Record<string, unknown>;
			const entry: PiLensProjectRuleConfig = {};
			if (
				typeof r.threshold === "number" &&
				Number.isFinite(r.threshold) &&
				r.threshold > 0
			) {
				entry.threshold = r.threshold;
			} else if ("threshold" in r) {
				warnInvalidConfigOnce(
					configPath,
					`rules.${ruleId}.threshold must be a positive finite number`,
				);
			}
			if ("disable" in r) {
				const parsed = parseRulePolicyList(
					configPath,
					ruleId,
					"disable",
					r.disable,
				);
				// #1087: an explicitly empty list is valid-but-empty (no warning);
				// don't store a pointless no-op entry for it.
				if (!parsed.invalid && parsed.list.length > 0)
					entry.disable = parsed.list;
			}
			if ("select" in r) {
				const parsed = parseRulePolicyList(
					configPath,
					ruleId,
					"select",
					r.select,
				);
				if (!parsed.invalid && parsed.list.length > 0)
					entry.select = parsed.list;
			}
			// Honor both threshold-only and policy-only entries; only drop if
			// the entry had no recognized fields at all (e.g. { unrelated: true }).
			// A recognized-but-malformed field already warned above, so only warn
			// here when nothing recognized was spelled at all — #444 proposed
			// `only` rather than `select`, and that typo must not fail silent.
			if (entry.threshold !== undefined || entry.disable || entry.select) {
				rules[ruleId] = entry;
			} else if (!("threshold" in r) && !("disable" in r) && !("select" in r)) {
				warnInvalidConfigOnce(
					configPath,
					`rules.${ruleId} has no recognized setting (threshold, disable, select); ignored`,
				);
			}
		}
	}

	let maxProjectFiles: number | undefined;
	if ("maxProjectFiles" in obj) {
		if (
			typeof obj.maxProjectFiles === "number" &&
			Number.isFinite(obj.maxProjectFiles) &&
			obj.maxProjectFiles > 0
		) {
			maxProjectFiles = obj.maxProjectFiles;
		} else {
			warnInvalidConfigOnce(
				configPath,
				"maxProjectFiles must be a positive finite number",
			);
		}
	}

	let reviewGraph: PiLensProjectReviewGraphConfig | undefined;
	if (obj.reviewGraph !== undefined) {
		if (
			!obj.reviewGraph ||
			typeof obj.reviewGraph !== "object" ||
			Array.isArray(obj.reviewGraph)
		) {
			warnInvalidConfigOnce(configPath, "reviewGraph must be an object");
		} else {
			const rg = obj.reviewGraph as Record<string, unknown>;
			if ("maxFiles" in rg) {
				const parsed = toPositiveFinite(rg.maxFiles);
				if (parsed > 0) {
					const clamped = Math.min(
						REVIEW_GRAPH_MAX_FILES_MAX,
						Math.max(REVIEW_GRAPH_MAX_FILES_MIN, Math.floor(parsed)),
					);
					reviewGraph = { maxFiles: clamped };
				} else {
					warnInvalidConfigOnce(
						configPath,
						"reviewGraph.maxFiles must be a positive finite number",
					);
				}
			}
		}
	}

	// #533 hygiene: mirror the global loader's unknown-key warn so a typo in a
	// shared `.pi-lens.json` (e.g. `maxProjectFile`, `lps`) produces a signal
	// instead of silently doing nothing. The recognized set is single-sourced
	// (#883): the project loader's own keys + the project-scoped flag sections
	// (registry-derived) + the foreign namespaces the LSP loader reads from this
	// same file. A key recognized ONLY at global scope (e.g. `lsp`, `tests`,
	// `delta`) gets a distinct, honest signal that it does nothing here rather
	// than being lumped in with typos — docs previously called this "silently
	// ignored".
	const knownProjectKeys = new Set<string>([
		...PROJECT_OWN_CONFIG_KEYS,
		...flagConfigSectionKeys(PROJECT_SCOPED_LENS_FLAGS),
		...PROJECT_FOREIGN_CONFIG_NAMESPACES,
	]);
	const globalScopeOnlyKeys = new Set<string>(
		[
			...flagConfigSectionKeys(LENS_FLAGS),
			...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
		].filter((key) => !knownProjectKeys.has(key)),
	);
	for (const key of Object.keys(obj)) {
		if (knownProjectKeys.has(key)) continue;
		if (globalScopeOnlyKeys.has(key)) {
			warnInvalidConfigOnce(
				configPath,
				`"${key}" is a global-only pi-lens setting and is not honored in a project .pi-lens.json (set it in ~/.pi-lens/config.json or pass the matching CLI flag); ignored`,
			);
		} else {
			warnInvalidConfigOnce(
				configPath,
				`unknown key "${key}" is not a recognized pi-lens setting (check for a typo); ignored`,
			);
		}
	}

	return {
		ignore,
		rules,
		...(mutations as Pick<
			PiLensProjectConfig,
			"format" | "autofix" | "actionableWarnings"
		>),
		maxProjectFiles,
		reviewGraph,
		raw,
		configPath,
	};
}
