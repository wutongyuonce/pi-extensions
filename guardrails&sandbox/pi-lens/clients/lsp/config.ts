/**
 * LSP Configuration for pi-lens
 *
 * Allows users to define custom LSP servers and override initialization options
 * for built-in servers via configuration.
 *
 * Config file: .pi-lens/lsp.json (or .pi-lens.json, pi-lsp.json)
 *
 * Example — custom server:
 * {
 *   "servers": {
 *     "my-server": {
 *       "name": "My Custom LSP",
 *       "extensions": [".myext"],
 *       "command": "my-lsp-server",
 *       "args": ["--stdio"],
 *       "rootMarkers": ["package.json"]
 *     }
 *   }
 * }
 *
 * Example — override initializationOptions for a built-in server:
 * {
 *   "serverOverrides": {
 *     "rust": {
 *       "initializationOptions": {
 *         "check": { "command": "clippy", "allTargets": true },
 *         "cargo": { "features": "all", "targetDir": true }
 *       }
 *     },
 *     "nix": {
 *       "initializationOptions": {
 *         "nixpkgs": { "expr": "import <nixpkgs> {}" },
 *         "options": {
 *           "home_manager": { "expr": "(builtins.getFlake (toString ./.)).homeConfigurations.me.options" }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * The `initializationOptions` object is deep-merged onto the server's built-in
 * defaults, so you only need to specify the keys you want to change or add.
 * User-supplied values win on conflicts at every level of nesting.
 *
 * Server IDs match the `id` field of each built-in server definition in
 * clients/lsp/server.ts (e.g. "rust", "nix", "bash", "python", "go", "ts").
 */

import { logExtension } from "../extension-log.js";
import { notifyUserDegradation } from "../user-notify.js";
import fs from "node:fs/promises";
import path from "node:path";
import { BoundedLruCache } from "../bounded-cache.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import { launchLSP } from "./launch.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "./session-roots.js";
import {
	createRootDetector,
	LSP_SERVERS,
	resetLSPCaseSensitivityState,
	type LSPServerInfo,
} from "./server.js";

// --- Types ---

export interface CustomServerConfig {
	name: string;
	extensions: string[];
	command: string;
	args?: string[];
	rootMarkers?: string[];
	env?: Record<string, string>;
}

/**
 * Per-server initializationOptions overrides for built-in servers.
 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python", "go").
 */
export interface ServerInitOverride {
	/**
	 * Deep-merged onto the server's built-in initializationOptions defaults.
	 * User values win on key conflicts at every nesting level.
	 */
	initializationOptions?: Record<string, unknown>;
}

export interface LSPConfig {
	servers?: Record<string, CustomServerConfig>;
	/**
	 * Override initializationOptions for built-in servers.
	 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python").
	 * Each entry's `initializationOptions` is deep-merged onto the server's
	 * built-in defaults so you only need to specify the keys you want to change.
	 */
	serverOverrides?: Record<string, ServerInitOverride>;
	disabledServers?: string[];
	/** Files to open at session start to seed lazy LSP indexing (e.g., clangd). */
	warmFiles?: string[];
}

interface RegisteredLSPConfig {
	customServers: LSPServerInfo[];
	disabledServerIds: Set<string>;
	serverOverrides: Map<string, ServerInitOverride>;
}

// --- Config Loading ---

const CONFIG_PATHS = [".pi-lens/lsp.json", ".pi-lens.json", "pi-lsp.json"];

function warnInvalidLSPConfig(configPath: string, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	const message = `ignoring invalid LSP config ${configPath}: ${reason}`;
	logExtension({
		subsystem: "lsp-config",
		level: "warn",
		message,
		metadata: { configPath, reason },
	});
	// HUMAN-audience too: the user's own lsp.json is being ignored (#1333).
	notifyUserDegradation(`pi-lens: ${message}`);
}

async function readLSPConfig(
	configPath: string,
): Promise<LSPConfig | undefined> {
	let content: string;
	try {
		content = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		warnInvalidLSPConfig(configPath, error);
		return undefined;
	}

	try {
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new TypeError("expected a JSON object");
		}
		return parsed as LSPConfig;
	} catch (error) {
		warnInvalidLSPConfig(configPath, error);
		return undefined;
	}
}

function mergeLSPConfigs(
	globalConfig: LSPConfig,
	projectConfig: LSPConfig,
): LSPConfig {
	const merged: LSPConfig = { ...globalConfig, ...projectConfig };

	const servers = { ...globalConfig.servers, ...projectConfig.servers };
	if (Object.keys(servers).length > 0) merged.servers = servers;

	const serverOverrides = {
		...globalConfig.serverOverrides,
		...projectConfig.serverOverrides,
	};
	if (Object.keys(serverOverrides).length > 0) {
		merged.serverOverrides = serverOverrides;
	}

	if (!Object.hasOwn(projectConfig, "disabledServers")) {
		merged.disabledServers = globalConfig.disabledServers;
	}
	if (!Object.hasOwn(projectConfig, "warmFiles")) {
		merged.warmFiles = globalConfig.warmFiles;
	}

	return merged;
}

/**
 * Load LSP configuration, with project settings overriding machine-global
 * settings from ~/.pi-lens/lsp.json.
 */
export async function loadLSPConfig(cwd: string): Promise<LSPConfig> {
	let projectConfig: LSPConfig | undefined;
	let dir = path.resolve(cwd);
	while (true) {
		for (const configPath of CONFIG_PATHS) {
			const fullPath = path.join(dir, configPath);
			const config = await readLSPConfig(fullPath);
			if (config) {
				projectConfig = config;
				break;
			}
		}
		if (projectConfig) break;

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const globalConfig =
		(await readLSPConfig(path.join(getGlobalPiLensDir(), "lsp.json"))) ?? {};
	return mergeLSPConfigs(globalConfig, projectConfig ?? {});
}

// --- Custom Server Factory ---

/**
 * Create LSPServerInfo from user configuration
 */
export function createCustomServer(
	config: CustomServerConfig,
	id: string,
): LSPServerInfo {
	return {
		id,
		name: config.name,
		extensions: config.extensions,
		root: config.rootMarkers
			? createRootDetector(config.rootMarkers)
			: async () => process.cwd(),
		async spawn(root) {
			const proc = await launchLSP(config.command, config.args ?? ["--stdio"], {
				cwd: root,
				env: config.env ? { ...process.env, ...config.env } : process.env,
			});
			return { process: proc };
		},
	};
}

// --- Registry Management ---

const EMPTY_CONFIG: RegisteredLSPConfig = {
	customServers: [],
	disabledServerIds: new Set(),
	serverOverrides: new Map(),
};

const workspaceConfigs = new BoundedLruCache<string, RegisteredLSPConfig>(32);
/** In-flight config initialization promises to prevent duplicate concurrent loads */
const configInFlight = new Map<string, Promise<void>>();

function normalizeWorkspacePath(cwd: string): string {
	return path.resolve(cwd);
}

function isSameOrChildPath(filePath: string, candidateRoot: string): boolean {
	if (filePath === candidateRoot) return true;
	return filePath.startsWith(`${candidateRoot}${path.sep}`);
}

function getConfigForFile(filePath: string): RegisteredLSPConfig {
	const resolvedFilePath = path.resolve(filePath);
	let bestMatch: { root: string; config: RegisteredLSPConfig } | undefined;

	for (const [root, config] of workspaceConfigs) {
		if (!isSameOrChildPath(resolvedFilePath, root)) continue;
		if (!bestMatch || root.length > bestMatch.root.length) {
			bestMatch = { root, config };
		}
	}

	return bestMatch?.config ?? EMPTY_CONFIG;
}

/**
 * Initialize LSP configuration (call at session start)
 * Deduplicates concurrent calls for the same workspace.
 */
export async function initLSPConfig(cwd: string): Promise<void> {
	const normalizedCwd = normalizeWorkspacePath(cwd);
	// #2052: this cwd is now a served session root. Registered BEFORE the
	// in-flight dedup return below, so a concurrent duplicate init still
	// registers it rather than returning early with the root unrecorded.
	registerSessionRoot(normalizedCwd);

	const existing = configInFlight.get(normalizedCwd);
	if (existing) return existing;

	const promise = (async () => {
		const config = await loadLSPConfig(cwd);
		const customServers: LSPServerInfo[] = [];
		const disabledServerIds = new Set(config.disabledServers ?? []);

		if (config.servers) {
			for (const [id, serverConfig] of Object.entries(config.servers)) {
				try {
					const server = createCustomServer(serverConfig, id);
					customServers.push(server);
				} catch {
					// pi-lens-ignore: missing-error-propagation — per-server registration, skip bad entries
				}
			}
		}

		const serverOverrides = new Map<string, ServerInitOverride>();
		if (config.serverOverrides) {
			for (const [id, entry] of Object.entries(config.serverOverrides)) {
				if (entry && typeof entry === "object" && !Array.isArray(entry)) {
					const initOpts = (entry as Record<string, unknown>)
						.initializationOptions;
					if (
						initOpts !== undefined &&
						typeof initOpts === "object" &&
						initOpts !== null &&
						!Array.isArray(initOpts)
					) {
						serverOverrides.set(id, {
							initializationOptions: initOpts as Record<string, unknown>,
						});
					}
				}
			}
		}

		workspaceConfigs.set(normalizedCwd, {
			customServers,
			disabledServerIds,
			serverOverrides,
		});
	})();

	configInFlight.set(normalizedCwd, promise);
	try {
		await promise;
	} finally {
		// Identity-guarded release (#1968's pattern): delete only if THIS run is
		// still the registered one. A bare delete-by-key lets a late-settling run
		// evict a live successor a second writer registered under the same cwd
		// mid-flight, after which the next caller starts a duplicate config load.
		if (configInFlight.get(normalizedCwd) === promise) {
			configInFlight.delete(normalizedCwd);
		}
	}
}

/**
 * Get all available servers (built-in + custom, minus disabled)
 */
export function getAllServers(filePath?: string): LSPServerInfo[] {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	const all = [...LSP_SERVERS, ...config.customServers];
	return all.filter((s) => !config.disabledServerIds.has(s.id));
}

/**
 * Check if a server is disabled
 */
export function isServerDisabled(serverId: string, filePath?: string): boolean {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	return config.disabledServerIds.has(serverId);
}

// --- Override getServersForFile to include custom servers

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath).toLowerCase();
	return getAllServers(filePath).filter((server) => {
		const extensions = server.extensions.map((value) => value.toLowerCase());
		const extensionMatch =
			extensions.includes(ext) || extensions.includes(base);
		if (!extensionMatch) return false;
		// #636: a server's extension match can be intentionally broader than what
		// it can usefully act on (zizmor attaches to "yaml" but only ever reports
		// on GitHub Actions workflow/action/dependabot paths). `pathFilter`, when
		// present, is an ADDITIONAL narrowing gate — never a widening one.
		return server.pathFilter ? server.pathFilter(filePath) : true;
	});
}

/**
 * The primary language server for a file (e.g. "typescript"), as opposed to a
 * cross-cutting auxiliary scanner attached via clientScope "all"/
 * "with-auxiliary" (ast-grep, opengrep, zizmor, typos, marksman, ...). `role`
 * is only ever set to "auxiliary" on those auxiliary entries (see
 * clients/lsp/server.ts) — undefined means a real language server. Used to
 * split a file's diagnostics into "primary confirmation" vs "auxiliary
 * findings" so a page of ast-grep/opengrep/marksman noise never buries
 * whether the actual type checker/compiler confirmed the file clean.
 *
 * #646: extracted from `tools/lsp-diagnostics.ts` (where it originated) so
 * `tools/lens-diagnostics.ts`'s `mode=full` sweep can share the exact same
 * primary/auxiliary classification instead of hand-copying it — both tools
 * now report the same primary-vs-auxiliary split for the same file.
 */
export function primaryServerId(filePath: string): string | undefined {
	return getServersForFileWithConfig(filePath).find(
		(s) => s.role !== "auxiliary",
	)?.id;
}

/**
 * Look up an initializationOptions override for a built-in server.
 * Returns undefined when no config was loaded or no override was specified
 * for this server ID.
 *
 * @param serverId  Built-in server id (e.g. "rust", "nix", "bash")
 * @param filePath  Any file path within the project (used to locate the
 *                  workspace config that was loaded for this directory tree)
 */
export function getServerInitOverride(
	serverId: string,
	filePath: string,
): ServerInitOverride | undefined {
	return getConfigForFile(filePath).serverOverrides.get(serverId);
}

export function resetLSPConfigStateForTests(): void {
	workspaceConfigs.clear();
	resetLSPCaseSensitivityState();
	// Reset both together: a cleared config store beside a live session-root
	// registry would decline files for roots nothing can serve any more.
	resetSessionRootsForTests();
}

/**
 * Test hook — read the `initLSPConfig` in-flight map directly (#1968's ABA
 * regression: a second writer replacing an entry mid-flight, then a
 * late-settling first run evicting it with a bare delete-by-key).
 */
export function _peekConfigInFlightForTests(): Map<string, Promise<void>> {
	return configInFlight;
}

// Re-export with config support
export { getAllServers as getServersForFile };
