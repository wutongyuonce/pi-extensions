import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tools.js";

const NEW_SETTINGS_FILE = "pi-firecrawl.json";
const LEGACY_SETTINGS_FILE = "pi-firecrawl-settings.json";

export interface FirecrawlSettings {
	tools: FirecrawlToolName[];
	updatedAt: number;
}

export type SettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: FirecrawlSettings; notice?: string };

type SettingsMigrationResult = {
	kind: "migrated" | "failed";
	notice: string;
};

export async function loadSettings(): Promise<SettingsLoadResult> {
	const newPath = settingsFilePath();
	const newSettings = await readSettingsFile(newPath);
	if (newSettings.kind !== "missing") {
		return withLegacyIgnoredNotice(newSettings);
	}

	const legacyPath = legacySettingsFilePath();
	const legacySettings = await readSettingsFile(legacyPath);
	const concurrentlyCreatedSettings = await readSettingsFile(newPath);
	if (concurrentlyCreatedSettings.kind !== "missing") {
		return withLegacyIgnoredNotice(concurrentlyCreatedSettings);
	}
	if (legacySettings.kind === "missing") return { kind: "missing" };
	if (legacySettings.kind === "invalid") return legacySettings;

	const migration = await migrateLegacySettings(legacyPath, legacySettings.settings);
	if (migration.kind === "failed") {
		const settingsCreatedDuringMigration = await readSettingsFile(newPath);
		if (settingsCreatedDuringMigration.kind !== "missing") {
			return withLegacyIgnoredNotice(settingsCreatedDuringMigration);
		}
	}

	return { ...legacySettings, notice: migration.notice };
}

async function readSettingsFile(filePath: string): Promise<SettingsLoadResult> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${filePath}: ${formatError(error)}` };
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const settings = normalizeFirecrawlSettings(parsed);
		if (settings) return { kind: "loaded", settings };
		return {
			kind: "invalid",
			reason: `${filePath}: expected tools to be an array of Firecrawl tool names`,
		};
	} catch (error) {
		return { kind: "invalid", reason: `${filePath}: ${formatError(error)}` };
	}
}

async function withLegacyIgnoredNotice(settings: SettingsLoadResult): Promise<SettingsLoadResult> {
	if (!(await fileExists(legacySettingsFilePath()))) return settings;
	return {
		...settings,
		notice: `Firecrawl legacy settings ignored: ${legacySettingsFilePath()} exists, but ${settingsFilePath()} takes precedence. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
	};
}

export async function installSettingsFileExclusively(filePath: string, contents: string) {
	await mkdir(dirname(filePath), { recursive: true });
	const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempFile, contents, { encoding: "utf8", flag: "wx" });
		await link(tempFile, filePath);
	} finally {
		await rm(tempFile, { force: true }).catch(() => undefined);
	}
}

async function migrateLegacySettings(
	legacyPath: string,
	settings: FirecrawlSettings,
): Promise<SettingsMigrationResult> {
	const newPath = settingsFilePath();
	try {
		await installSettingsFileExclusively(newPath, `${JSON.stringify(settings, null, 2)}\n`);
	} catch (error) {
		return {
			kind: "failed",
			notice: `Firecrawl legacy settings migration failed: could not migrate ${legacyPath} to ${newPath}: ${formatError(error)}. The legacy file was used for this session; future saves will write ${NEW_SETTINGS_FILE}.`,
		};
	}

	try {
		await rm(legacyPath, { force: true });
	} catch (error) {
		return {
			kind: "migrated",
			notice: `Firecrawl settings migrated from ${legacyPath} to ${newPath}, but the legacy file could not be removed: ${formatError(error)}. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
		};
	}

	return {
		kind: "migrated",
		notice: `Firecrawl settings migrated from ${legacyPath} to ${newPath}. ${LEGACY_SETTINGS_FILE} is deprecated and will be removed in a future major release.`,
	};
}

async function fileExists(filePath: string) {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function normalizeFirecrawlSettings(value: unknown): FirecrawlSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { tools?: unknown; updatedAt?: unknown };
	if (typeof settings.updatedAt !== "number") return undefined;
	if (!Array.isArray(settings.tools)) return undefined;
	if (!settings.tools.every(isFirecrawlToolName)) return undefined;
	return { tools: orderedUniqueFirecrawlTools(settings.tools), updatedAt: settings.updatedAt };
}

function isFirecrawlToolName(value: unknown): value is FirecrawlToolName {
	return typeof value === "string" && FIRECRAWL_TOOL_NAMES.includes(value as never);
}

function orderedUniqueFirecrawlTools(tools: readonly FirecrawlToolName[]) {
	const selectedTools = new Set(tools);
	return FIRECRAWL_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

export async function saveSettings(settings: FirecrawlSettings) {
	const filePath = settingsFilePath();
	await mkdir(dirname(filePath), { recursive: true });
	const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await rename(tempFile, filePath);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function settingsFilePath() {
	return join(agentDir(), NEW_SETTINGS_FILE);
}

function legacySettingsFilePath() {
	return join(agentDir(), LEGACY_SETTINGS_FILE);
}

function agentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
