// One-click diagnostics bundle (spec §6.17): a sanitized, AI-consumable
// artifact for issue → fix → TDD closure. Pure core is unit-testable:
// sanitization pipeline, doctor checks, ISSUE.md template, size capping.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	FeishuConfig,
	StatusSnapshot,
	OutboundEnvelope,
} from "./types.js";
import type { LogEvent } from "./logger.js";
import { hashId, sanitizeConfig } from "./config.js";

export interface DoctorCheck {
	check: string;
	status: "ok" | "warn" | "error";
	detail?: string;
}

export interface VersionsInfo {
	extension: string;
	pi: string;
	node: string;
	os: string;
	arch: string;
	sdk: string;
	uptimeMs: number;
	configSchema: number;
}

export interface FailedEnvelopeMeta {
	id: string;
	kind: OutboundEnvelope["kind"];
	laneKey: string;
	attempts: number;
	lastError?: string;
	createdAt: number;
}

export interface DiagnosticsInput {
	config: FeishuConfig;
	status: StatusSnapshot;
	stateTransitions: Array<{
		from: string;
		to: string;
		ts: number;
		detail?: string;
	}>;
	recentEvents: LogEvent[];
	doctor: DoctorCheck[];
	outboxPending: number;
	outboxFailed: Array<FailedEnvelopeMeta>;
	reproTrace: unknown[];
	versions: VersionsInfo;
	includeContent: boolean;
}

export const DIAG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_TRANSITIONS = 50;

/** Replace open_id / chat_id / user ids anywhere in an event's data. */
export function sanitizeEvent(
	event: LogEvent,
	includeContent: boolean,
): LogEvent {
	const data = sanitizeValue(event.data, includeContent);
	return { ...event, data: data as Record<string, unknown> | undefined };
}

function sanitizeValue(
	value: unknown,
	includeContent: boolean,
	depth = 0,
): unknown {
	if (depth > 6) return "[deep]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		// Long strings are message content → excluded unless opted in.
		if (!includeContent && value.length > 64) {
			return `[${value.length} chars sha256:${createHash("sha256").update(value).digest("hex").slice(0, 8)}]`;
		}
		// Hash known id shapes (openid/chatid/unionid style: ou_, oc_, om_, on_, …).
		if (/^(ou_|oc_|om_|ov_|oi_|og_|on_|au_|ob_)/.test(value))
			return hashId(value);
		return value.replaceAll(homedir(), "~");
	}
	if (Array.isArray(value))
		return value.map((v) => sanitizeValue(v, includeContent, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = sanitizeValue(v, includeContent, depth + 1);
		}
		return out;
	}
	return value;
}

/** Run doctor checks against a snapshot; returns ordered check list. */
export function runDoctorChecks(input: DiagnosticsInput): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	// config
	const cfgValid =
		input.config.appId.length > 0 && input.config.appSecret.length > 0;
	checks.push({
		check: "config",
		status: cfgValid ? "ok" : "error",
		detail: cfgValid
			? `domain=${input.config.domain}`
			: "missing appId/appSecret",
	});
	// connection
	checks.push({
		check: "connection",
		status:
			input.status.connState === "connected"
				? "ok"
				: input.status.connState === "degraded"
					? "warn"
					: "error",
		detail: `${input.status.connState} · probe ${input.status.lastProbeOk === false ? "fail" : `${input.status.lastProbeLatencyMs ?? "?"}ms`} · reconnects=${input.status.reconnectCount}`,
	});
	// outbox backlog
	checks.push({
		check: "outbox",
		status:
			input.outboxPending === 0
				? "ok"
				: input.outboxPending < 5
					? "warn"
					: "error",
		detail: `pending=${input.outboxPending} failed=${input.outboxFailed.length}`,
	});
	// disk (basic)
	checks.push({
		check: "runtime",
		status: "ok",
		detail: `events sampled=${input.recentEvents.length}`,
	});
	return checks;
}

/** Build the ISSUE.md template with environment + timeline. */
export function buildIssueMd(input: DiagnosticsInput): string {
	const red = input.doctor.filter((c) => c.status === "error");
	const yellow = input.doctor.filter((c) => c.status === "warn");
	const env = [
		`- Extension: ${input.versions.extension}`,
		`- Pi: ${input.versions.pi}`,
		`- Node: ${input.versions.node}`,
		`- OS: ${input.versions.os} (${input.versions.arch})`,
		`- SDK: ${input.versions.sdk}`,
		`- Uptime: ${Math.round(input.versions.uptimeMs / 1000)}s`,
		`- Config schema: ${input.versions.configSchema}`,
	].join("\n");
	const redItems = red.length
		? red.map((c) => `- ❌ ${c.check}: ${c.detail ?? ""}`).join("\n")
		: "- 无红项";
	const yellowItems = yellow.length
		? yellow.map((c) => `- ⚠️ ${c.check}: ${c.detail ?? ""}`).join("\n")
		: "";
	const problemItems = [redItems, yellowItems].filter(Boolean).join("\n");
	const timeline = input.reproTrace.length
		? "```json\n" +
			JSON.stringify(input.reproTrace.slice(-20), null, 2) +
			"\n```"
		: "（无失败回合 trace）";
	return [
		"## 问题描述（请填写）",
		"",
		"复现步骤：",
		"1. ",
		"",
		"## 环境",
		env,
		"",
		"## 自检结果",
		problemItems,
		"",
		"## 事件时间线（最近失败回合，脱敏）",
		timeline,
		"",
		"> 诊断包由 /doctor 生成。已自动脱敏：凭据掩码、id 哈希、消息内容默认不包含。",
	].join("\n");
}

/** Build the in-bundle log format README for AI consumption. */
export function buildBundleReadme(): string {
	return [
		"# 诊断包格式说明",
		"",
		"本包用于 pi-feishu-link 的 issue 定位。文件清单：",
		"- `manifest.json` — 版本指纹",
		"- `doctor.json` — 自检绿黄红",
		"- `config.json` — 脱敏配置",
		"- `status.json` — 连接状态快照",
		"- `events.jsonl` — 结构化事件（JSON Lines，每行一个事件）",
		"- `outbox-summary.json` — 投递队列积压元数据",
		"- `repro-trace.jsonl` — 最近失败回合的事件序列",
		"- `ISSUE.md` — 预填 issue 模板",
		"",
		"## 事件字段",
		"- `ts` — epoch 毫秒",
		"- `level` — debug/info/warn/error",
		"- `event` — 点分事件名（如 feishu.outbox.sent）",
		"- `data` — 附加字段（已脱敏：ou_/oc_ 前缀 id 已哈希，长字符串为内容摘要）",
		"",
		"## 错误码（事件名 → 含义）",
		"- `feishu.outbox.retryable` — 投递暂时失败，正在退避重试",
		"- `feishu.outbox.fatal` — 投递终态失败（4xx，如会话已失效）",
		"- `feishu.conn.*` — 连接状态迁移",
		"- `feishu.prompt.error` — 回合异常",
		"",
		"修复流程：复现 → 写测试 → 修复 → `npm test` 全绿。",
	].join("\n");
}

export interface BuildResult {
	files: string[];
	bytes: number;
	truncated: boolean;
}

/** Write the diagnostics bundle into outDir. Pure-ish; testable. */
export function buildDiagnostics(
	input: DiagnosticsInput,
	outDir: string,
): BuildResult {
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	// Clear any previous bundle contents (scan all files, not just known names).
	try {
		for (const f of readdirSync(outDir)) {
			rmSync(join(outDir, f), { recursive: true, force: true });
		}
	} catch {
		/* ignore */
	}

	const manifest = {
		generatedAt: Date.now(),
		...input.versions,
	};
	const transitions = input.stateTransitions.slice(-MAX_TRANSITIONS);
	const status = { ...input.status, stateTransitions: transitions };
	const events = input.recentEvents
		.slice(-MAX_EVENTS)
		.map((e) => sanitizeEvent(e, input.includeContent));
	const outboxSummary = {
		pending: input.outboxPending,
		failed: input.outboxFailed.map((f) => ({
			id: hashId(f.id),
			kind: f.kind,
			laneKey: hashId(f.laneKey),
			attempts: f.attempts,
			lastError: f.lastError,
			createdAt: f.createdAt,
		})),
	};
	const doctor = input.doctor;
	const config = sanitizeConfig(input.config);
	const trace = input.reproTrace.map((t) =>
		sanitizeValue(t, input.includeContent),
	);

	writeFileSync(
		join(outDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
	writeFileSync(join(outDir, "doctor.json"), JSON.stringify(doctor, null, 2));
	writeFileSync(join(outDir, "config.json"), JSON.stringify(config, null, 2));
	writeFileSync(join(outDir, "status.json"), JSON.stringify(status, null, 2));
	writeFileSync(
		join(outDir, "events.jsonl"),
		events.map((e) => JSON.stringify(e)).join("\n"),
	);
	writeFileSync(
		join(outDir, "outbox-summary.json"),
		JSON.stringify(outboxSummary, null, 2),
	);
	writeFileSync(
		join(outDir, "repro-trace.jsonl"),
		trace.map((t) => JSON.stringify(t)).join("\n"),
	);
	writeFileSync(join(outDir, "ISSUE.md"), buildIssueMd(input));
	writeFileSync(join(outDir, "README-IN-BUNDLE.md"), buildBundleReadme());

	let bytes = 0;
	let truncated = false;
	for (const f of existingFiles(outDir)) {
		const size = statSync(f).size;
		bytes += size;
	}
	if (bytes > DIAG_MAX_BYTES) {
		// Drop oldest events until under cap (keep ISSUE.md + manifest).
		let over = bytes - DIAG_MAX_BYTES;
		const evPath = join(outDir, "events.jsonl");
		if (existsSync(evPath) && over > 0) {
			const lines = readLines(evPath);
			const kept: string[] = [];
			for (const line of lines) {
				over -= Buffer.byteLength(line, "utf8");
				if (over > 0) continue;
				kept.push(line);
			}
			writeFileSync(evPath, kept.join("\n"));
			truncated = true;
		}
		bytes = 0;
		for (const f of existingFiles(outDir)) bytes += statSync(f).size;
	}
	return {
		files: existingFiles(outDir).map((f) => f.split("/").pop()!),
		bytes,
		truncated,
	};
}

function existingFiles(dir: string): string[] {
	return [
		"manifest.json",
		"doctor.json",
		"config.json",
		"status.json",
		"events.jsonl",
		"outbox-summary.json",
		"repro-trace.jsonl",
		"ISSUE.md",
		"README-IN-BUNDLE.md",
	]
		.map((f) => join(dir, f))
		.filter((f) => existsSync(f));
}

function readLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l.length > 0);
	} catch {
		return [];
	}
}
