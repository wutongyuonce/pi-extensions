import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_CONFIG_FILE_NAME = "pi-subagents.json";
const ORCHESTRATOR_DEFAULT_KEY = "orchestratorDefault";

type OrchestratorSavedDefaultSource = "saved" | "missing" | "error";
type OrchestratorEffectiveDefaultSource =
	| "env"
	| "saved"
	| "missing"
	| "invalid-env"
	| "error";

/** Persisted global orchestrator configuration and its read status. */
export interface OrchestratorGlobalConfig {
	path: string;
	savedDefault: boolean;
	source: OrchestratorSavedDefaultSource;
	error?: string;
}

/** Orchestrator default after applying environment and persisted settings. */
export interface OrchestratorEffectiveDefault {
	value: boolean;
	source: OrchestratorEffectiveDefaultSource;
	error?: string;
}

/** Result of writing the persisted global orchestrator default. */
export interface OrchestratorConfigWriteResult {
	ok: boolean;
	path: string;
	error?: string;
}

interface LoadedConfigFile {
	path: string;
	data: Record<string, unknown>;
	config: OrchestratorGlobalConfig;
}

function getOrchestratorConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, ORCHESTRATOR_CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function loadConfigFile(agentDir = getAgentDir()): LoadedConfigFile {
	const path = getOrchestratorConfigPath(agentDir);
	try {
		if (!existsSync(path)) {
			return {
				path,
				data: {},
				config: { path, savedDefault: false, source: "missing" },
			};
		}

		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) {
			throw new Error("expected a JSON object");
		}
		if (
			parsed[ORCHESTRATOR_DEFAULT_KEY] !== undefined &&
			typeof parsed[ORCHESTRATOR_DEFAULT_KEY] !== "boolean"
		) {
			throw new Error(`${ORCHESTRATOR_DEFAULT_KEY} must be a boolean`);
		}

		const savedDefault = parsed[ORCHESTRATOR_DEFAULT_KEY];
		return {
			path,
			data: parsed,
			config: {
				path,
				savedDefault: typeof savedDefault === "boolean" ? savedDefault : false,
				source: typeof savedDefault === "boolean" ? "saved" : "missing",
			},
		};
	} catch (error) {
		const message = `Could not read ${path}: ${formatError(error)}`;
		return {
			path,
			data: {},
			config: { path, savedDefault: false, source: "error", error: message },
		};
	}
}

/** Load the persisted global orchestrator configuration for an agent directory. */
export function loadOrchestratorGlobalConfig(
	agentDir = getAgentDir(),
): OrchestratorGlobalConfig {
	return loadConfigFile(agentDir).config;
}

/** Resolve the effective default, with environment values taking precedence. */
export function resolveOrchestratorEffectiveDefault(
	env: Record<string, string | undefined> = process.env,
	agentDir = getAgentDir(),
): OrchestratorEffectiveDefault {
	const config = loadOrchestratorGlobalConfig(agentDir);
	const rawEnv = env.PI_ORCHESTRATOR_MODE;
	if (rawEnv !== undefined) {
		if (rawEnv === "1")
			return {
				value: true,
				source: "env",
				...(config.error ? { error: config.error } : {}),
			};
		if (rawEnv === "0")
			return {
				value: false,
				source: "env",
				...(config.error ? { error: config.error } : {}),
			};
		return {
			value: false,
			source: "invalid-env",
			error: `PI_ORCHESTRATOR_MODE must be "1" or "0" (got ${JSON.stringify(rawEnv)}).`,
		};
	}
	if (config.source === "saved")
		return { value: config.savedDefault, source: "saved" };
	if (config.source === "error")
		return { value: false, source: "error", error: config.error };
	return { value: false, source: "missing" };
}

/** Persist the global default without discarding unrelated config properties. */
export function saveOrchestratorGlobalDefault(
	enabled: boolean,
	agentDir = getAgentDir(),
): OrchestratorConfigWriteResult {
	const loaded = loadConfigFile(agentDir);
	if (loaded.config.source === "error" && existsSync(loaded.path)) {
		return { ok: false, path: loaded.path, error: loaded.config.error };
	}

	const next = { ...loaded.data, [ORCHESTRATOR_DEFAULT_KEY]: enabled };
	const temporaryPath = join(
		agentDir,
		`.${basename(loaded.path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, loaded.path);
		return { ok: true, path: loaded.path };
	} catch (error) {
		const message = `Could not write ${loaded.path}: ${formatError(error)}`;
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The temporary file may not have been created or may already have been renamed.
		}
		return { ok: false, path: loaded.path, error: message };
	}
}
