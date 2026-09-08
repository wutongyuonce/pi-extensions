// Configuration loading, validation, sanitization, and persistent state helpers.
// No pi SDK imports here — kept dependency-free so it is unit-testable.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DONE_EMOJI, REACTION_POOL } from "./reactions.js";
import type { FeishuConfig } from "./types.js";

const SCHEMA_VERSION = 1;
export const BRIDGE_HOME_ENV = "PI_FEISHU_LINK_HOME";
export const CHILD_SESSION_ENV = "PI_FEISHU_LINK_CHILD";

/** Root state directory. Default: ~/.pi/agent/feishu-link. */
export function rootDir(): string {
	const env = process.env[BRIDGE_HOME_ENV];
	return env ? resolve(env) : join(homedir(), ".pi", "agent", "feishu-link");
}

function configPath(): string {
	return join(rootDir(), "config.json");
}
function overridesPath(): string {
	return join(rootDir(), "runtime-overrides.json");
}

export function logsPath(): string {
	return join(rootDir(), "logs");
}

export const DEFAULT_CONFIG: FeishuConfig = {
	schemaVersion: SCHEMA_VERSION,
	appId: "",
	appSecret: "",
	domain: "feishu",
	autoStart: true,
	groupPolicy: "open",
	groupKeywords: [],
	groupAlsoOnReply: true,
	allowUsers: [],
	allowChats: [],
	admins: [],
	ownerOpenId: undefined,
	forward: {
		aiReply: { mode: "card" },
		streaming: { enabled: false, throttleMs: 800 },
		toolCalls: { mode: "summary" },
		reasoning: { mode: "off" },
		progress: { enabled: true },
		reactions: {
			enabled: true,
			emojis: [...REACTION_POOL],
			doneEmoji: DONE_EMOJI,
		},
	},
	connection: {
		probeIntervalMs: 30_000,
		silenceSuspectMs: 1_200_000,
		reconnectBackoffMaxMs: 60_000,
		downReportEnabled: true,
	},
	turns: {
		turnTimeoutMs: 1_800_000,
		ackAfterMs: 15_000,
		queueWarnMs: 120_000,
	},
	sessions: {
		maxResident: 8,
		idleDisposeMs: 1_800_000,
	},
	outbox: {
		dir: "", // resolved lazily via outboxDir()
		maxAttemptsBeforeAlert: 8,
		sentRetentionMs: 604_800_000,
		maxPendingEnvelopes: 1000,
		maxEnvelopeBytes: 262_144,
		maxOutboxDirBytes: 52_428_800,
		compactIntervalMs: 3_600_000,
	},
	media: {
		maxAttachments: 4,
		maxTotalBytes: 31_457_280,
	},
	storage: {
		sessionRetentionDays: 0,
	},
	permissions: {
		policy: "relaxed",
		autoApprove: [
			"read",
			"grep",
			"find",
			"ls",
			"glob",
			"rg",
			"feishu_send_local_file",
		],
		approvalTimeoutMs: 300_000,
		sessionMemory: true,
	},
	notifications: {
		mergeWindowMs: 600_000,
	},
	logging: { level: "info" },
};

export function ensureRoot(): void {
	mkdirSync(rootDir(), { recursive: true, mode: 0o700 });
}

/** Deep-merge plain objects (right wins), arrays replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === undefined || patch === null) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return patch as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		const existing = out[k];
		if (
			typeof existing === "object" &&
			existing !== null &&
			!Array.isArray(existing) &&
			typeof v === "object" &&
			v !== null &&
			!Array.isArray(v)
		) {
			out[k] = deepMerge(existing, v);
		} else {
			out[k] = v;
		}
	}
	return out as T;
}

/** Atomic JSON write; sensitive files get 0o600. */
export function writeJson(path: string, value: unknown, mode = 0o600): void {
	ensureRoot();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
		mode,
		encoding: "utf8",
	});
	renameSync(tmp, path);
	if (process.platform !== "win32") {
		try {
			statSync(path);
			chmodSync(path, mode);
		} catch {
			/* ignore */
		}
	}
}

export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Validate config shape; returns list of problems (empty = valid). */
export function validateConfig(cfg: unknown): string[] {
	const problems: string[] = [];
	if (typeof cfg !== "object" || cfg === null) {
		return ["config is not an object"];
	}
	const c = cfg as Record<string, unknown>;
	if (c.schemaVersion !== SCHEMA_VERSION) {
		problems.push(`unsupported schemaVersion ${String(c.schemaVersion)}`);
	}
	if (
		typeof c.appId === "string" &&
		c.appId.length > 0 &&
		!/^cli_[A-Za-z0-9]+$/.test(c.appId)
	) {
		problems.push("appId looks malformed (expected cli_ prefix)");
	}
	if (c.domain !== "feishu" && c.domain !== "lark") {
		problems.push(`invalid domain ${String(c.domain)}`);
	}
	if (c.groupPolicy !== "open" && c.groupPolicy !== "mention") {
		problems.push("groupPolicy must be open|mention");
	}
	const perms = c.permissions as Record<string, unknown> | undefined;
	if (perms && perms.policy !== "relaxed" && perms.policy !== "strict") {
		problems.push("permissions.policy must be relaxed|strict");
	}
	return problems;
}

/** True when app credentials are present. */
export function isConfigured(cfg: FeishuConfig | undefined): boolean {
	return Boolean(cfg && cfg.appId && cfg.appSecret);
}

/** Load config + runtime overrides; returns undefined when missing/unreadable. */
export function loadConfig(): FeishuConfig | undefined {
	const raw = readJson<Partial<FeishuConfig> | undefined>(
		configPath(),
		undefined,
	);
	if (!raw) return undefined;
	const merged = deepMerge(
		structuredClone(DEFAULT_CONFIG),
		raw,
	) as FeishuConfig;
	const problems = validateConfig(merged);
	if (problems.length > 0) return undefined;
	const overrides = readJson<Record<string, unknown> | undefined>(
		overridesPath(),
		undefined,
	);
	if (overrides) {
		const overridden = deepMerge(merged, overrides);
		if (validateConfig(overridden).length === 0)
			return overridden as FeishuConfig;
	}
	return merged;
}

export function saveConfig(cfg: FeishuConfig): void {
	writeJson(configPath(), cfg);
}

export function saveOverrides(overrides: Record<string, unknown>): void {
	writeJson(overridesPath(), overrides, 0o600);
}

export function loadOverrides(): Record<string, unknown> | undefined {
	return readJson<Record<string, unknown> | undefined>(
		overridesPath(),
		undefined,
	);
}

/** Mask secrets: keep first 4 chars. */
export function mask(secret: string): string {
	if (!secret) return "";
	if (secret.length <= 8) return "****";
	return `${secret.slice(0, 4)}****${secret.slice(-2)}`;
}

/** Stable short hash for ids (open_id/chat_id) in diagnostics. */
export function hashId(id: string): string {
	return createHash("sha256")
		.update(`pi-feishu-link\0${id}`)
		.digest("hex")
		.slice(0, 12);
}

/** Sanitized config for diagnostics: masks secrets, hashes ids, normalizes paths. */
export function sanitizeConfig(cfg: FeishuConfig): Record<string, unknown> {
	const clone = structuredClone(cfg) as unknown as Record<string, unknown>;
	clone.appSecret = mask(String(clone.appSecret ?? ""));
	if (typeof clone.appId === "string") clone.appId = mask(clone.appId);
	if (Array.isArray(clone.allowUsers))
		clone.allowUsers = clone.allowUsers.map(hashId);
	if (Array.isArray(clone.allowChats))
		clone.allowChats = clone.allowChats.map(hashId);
	if (Array.isArray(clone.admins)) clone.admins = clone.admins.map(hashId);
	if (typeof clone.ownerOpenId === "string" && clone.ownerOpenId)
		clone.ownerOpenId = hashId(clone.ownerOpenId);
	return clone;
}

/** Normalize a user-supplied absolute path (expand ~, resolve). */
export function normalizePath(input: string): string {
	const trimmed = input.trim();
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/")
			? join(homedir(), trimmed.slice(2))
			: trimmed;
	return resolve(expanded);
}
