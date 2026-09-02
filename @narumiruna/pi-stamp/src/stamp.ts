import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	DEFAULT_STAMP_SETTINGS,
	formatExactTimelineLine,
	formatMessageStampLabel,
	formatStampLabel,
	type StampSettings,
	type StampTimelineBoundary,
} from "./format.js";
import {
	type AssistantMetadataData,
	captureAssistantMetadata,
	formatAssistantMetadataLines,
	formatToolStampLabel,
	isAssistantMetadataData,
	isStampThinkingLevel,
	type StampThinkingLevel,
	sanitizeMetadataText,
	sanitizeTerminalText,
	type ToolStampOutcome,
} from "./metadata.js";
import { createStampSettingsRuntime, type StampSettingsRuntime } from "./settings.js";

export const STAMP_ENTRY_TYPE = "pi-stamp";
export const MAX_TOOL_STAMP_OBSERVATIONS = 256;

export interface MessageStampDataV1 {
	version: 1;
	role: "user" | "assistant";
	timestamp: number;
}

export interface MessageStampDataV2 {
	version: 2;
	role: "user" | "assistant";
	timestamp: number;
	previousTimestamp?: number;
}

export interface AssistantMessageStampDataV3 {
	version: 3;
	role: "assistant";
	timestamp: number;
	previousTimestamp?: number;
	completedAt: number;
	firstContentAt?: number;
}

export interface AssistantMessageStampDataV4 {
	version: 4;
	role: "assistant";
	timestamp: number;
	previousTimestamp?: number;
	completedAt?: number;
	firstContentAt?: number;
	metadata: AssistantMetadataData;
}

export interface AssistantMessageStampDataV5 {
	version: 5;
	role: "assistant";
	timestamp: number;
	previousTimestamp?: number;
	completedAt?: number;
	firstContentAt?: number;
	metadata: AssistantMetadataData;
	thinkingLevel: StampThinkingLevel;
}

export interface ToolStampDataV1 {
	version: 1;
	kind: "tool";
	toolCallId: string;
	toolName: string;
	startedAt: number;
	completedAt: number;
	outcome: ToolStampOutcome;
}

export type MessageStampData =
	| MessageStampDataV1
	| MessageStampDataV2
	| AssistantMessageStampDataV3
	| AssistantMessageStampDataV4
	| AssistantMessageStampDataV5;
export type StampEntryData = MessageStampData | ToolStampDataV1;

export interface StampExtensionOptions {
	settingsRuntime?: StampSettingsRuntime;
	now?: () => number;
}

interface AssistantTimingObservation {
	timestamp: number;
	firstContentAt?: number;
}

interface FinalizedAssistantTiming extends AssistantTimingObservation {
	completedAt: number;
}

interface ToolTimingObservation {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	completedAt?: number;
	outcome?: ToolStampOutcome;
}

export function formatStampTime(timestamp: number): string | undefined {
	return formatStampLabel(timestamp, undefined, {
		...DEFAULT_STAMP_SETTINGS,
		dateContext: "never",
	});
}

export function isMessageStampData(value: unknown): value is MessageStampData {
	if (!isRecord(value) || !isStampRole(value.role) || !isValidTimestamp(value.timestamp)) {
		return false;
	}
	if (value.version === 1) {
		return hasOnlyKeys(value, ["version", "role", "timestamp"]);
	}
	if (value.version === 2) {
		return (
			hasOnlyKeys(value, ["version", "role", "timestamp", "previousTimestamp"]) &&
			(!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp))
		);
	}
	if (value.version === 3) {
		return (
			value.role === "assistant" &&
			hasOnlyKeys(value, [
				"version",
				"role",
				"timestamp",
				"previousTimestamp",
				"completedAt",
				"firstContentAt",
			]) &&
			isValidTimestamp(value.completedAt) &&
			value.completedAt >= value.timestamp &&
			(!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp)) &&
			(!Object.hasOwn(value, "firstContentAt") ||
				(isValidTimestamp(value.firstContentAt) &&
					value.firstContentAt >= value.timestamp &&
					value.firstContentAt <= value.completedAt))
		);
	}
	if ((value.version !== 4 && value.version !== 5) || value.role !== "assistant") return false;
	const allowedKeys = [
		"version",
		"role",
		"timestamp",
		"previousTimestamp",
		"completedAt",
		"firstContentAt",
		"metadata",
		...(value.version === 5 ? ["thinkingLevel"] : []),
	];
	if (
		!hasOnlyKeys(value, allowedKeys) ||
		(Object.hasOwn(value, "previousTimestamp") && !isValidTimestamp(value.previousTimestamp)) ||
		!isAssistantMetadataData(value.metadata) ||
		(value.version === 5 && !isStampThinkingLevel(value.thinkingLevel))
	) {
		return false;
	}
	if (!Object.hasOwn(value, "completedAt")) return !Object.hasOwn(value, "firstContentAt");
	return (
		isValidTimestamp(value.completedAt) &&
		value.completedAt >= value.timestamp &&
		(!Object.hasOwn(value, "firstContentAt") ||
			(isValidTimestamp(value.firstContentAt) &&
				value.firstContentAt >= value.timestamp &&
				value.firstContentAt <= value.completedAt))
	);
}

export function isToolStampData(value: unknown): value is ToolStampDataV1 {
	return (
		isRecord(value) &&
		value.version === 1 &&
		value.kind === "tool" &&
		hasOnlyKeys(value, [
			"version",
			"kind",
			"toolCallId",
			"toolName",
			"startedAt",
			"completedAt",
			"outcome",
		]) &&
		isSafePersistedText(value.toolCallId) &&
		isSafePersistedText(value.toolName) &&
		isValidTimestamp(value.startedAt) &&
		isValidTimestamp(value.completedAt) &&
		value.completedAt >= value.startedAt &&
		(value.outcome === "success" || value.outcome === "error")
	);
}

interface RightAlignedLine {
	text: string;
	exact: boolean;
}

export function createStampEntryRenderer(
	getSettings: () => Readonly<StampSettings>,
): EntryRenderer<StampEntryData> {
	return (entry, options, theme) => {
		if (isToolStampData(entry.data)) {
			if (!getSettings().toolStamps) return undefined;
			const data = entry.data;
			return dynamicRightAlignedText(
				() => {
					const settings = getSettings();
					if (!settings.toolStamps) return [];
					const label = formatToolStampLabel(
						data.toolName,
						data.completedAt - data.startedAt,
						data.outcome,
					);
					if (!label) return [];
					return [
						regularLine(label),
						...(options.expanded && settings.showExactTimeline
							? exactTimelineLines([
									["started", data.startedAt],
									["completed", data.completedAt],
								])
							: []),
					];
				},
				(line) => theme.fg("dim", line),
			);
		}
		if (!isMessageStampData(entry.data)) return undefined;
		const data = entry.data;
		return dynamicRightAlignedText(
			() => {
				const settings = getSettings();
				const hasAssistantTiming = data.version === 3 || data.version === 4 || data.version === 5;
				const label = formatMessageStampLabel(
					{
						timestamp: data.timestamp,
						...(data.version === 1 ? {} : { previousTimestamp: data.previousTimestamp }),
						...(hasAssistantTiming
							? {
									completedAt: data.completedAt,
									firstContentAt: data.firstContentAt,
								}
							: {}),
					},
					settings,
				);
				if (!label) return [];
				const timelineObservations: Array<readonly [StampTimelineBoundary, number]> = [
					["created", data.timestamp],
				];
				if (hasAssistantTiming && data.firstContentAt !== undefined) {
					timelineObservations.push(["first content", data.firstContentAt]);
				}
				if (hasAssistantTiming && data.completedAt !== undefined) {
					timelineObservations.push(["completed", data.completedAt]);
				}
				const timelineLines =
					options.expanded && settings.showExactTimeline
						? exactTimelineLines(timelineObservations)
						: [];
				const metadataLines =
					data.version === 4 || data.version === 5
						? formatAssistantMetadataLines(
								data.metadata,
								settings.assistantMetadata,
								options.expanded,
								data.version === 5 && settings.showThinkingLevel ? data.thinkingLevel : undefined,
								settings.showCompactAbnormalOutcome,
							)
						: [];
				return [regularLine(label), ...timelineLines, ...metadataLines.map(regularLine)];
			},
			(line) => theme.fg("dim", line),
		);
	};
}

export const renderStampEntry = createStampEntryRenderer(() => DEFAULT_STAMP_SETTINGS);

function regularLine(text: string): RightAlignedLine {
	return { text, exact: false };
}

function exactTimelineLines(
	observations: ReadonlyArray<readonly [StampTimelineBoundary, number]>,
): RightAlignedLine[] {
	return observations.flatMap(([boundary, timestamp]) => {
		const text = formatExactTimelineLine(boundary, timestamp);
		return text ? [{ text, exact: true }] : [];
	});
}

function dynamicRightAlignedText(
	getLines: () => readonly RightAlignedLine[],
	style: (text: string) => string,
): Component {
	return {
		render(width) {
			if (width < 1) return [];
			return getLines().flatMap((source) => {
				const lines = source.exact
					? hardWrapExactText(source.text, width).map(style)
					: wrapTextWithAnsi(style(source.text), width);
				return lines.map((line) => {
					const leftPadding = " ".repeat(Math.max(0, width - visibleWidth(line)));
					return `${leftPadding}${line}`;
				});
			});
		},
		invalidate() {},
	};
}

function hardWrapExactText(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const character of text) {
		const characterWidth = visibleWidth(character);
		if (line && lineWidth + characterWidth > width) {
			lines.push(line);
			line = "";
			lineWidth = 0;
		}
		if (characterWidth > width) continue;
		line += character;
		lineWidth += characterWidth;
	}
	if (line) lines.push(line);
	return lines;
}

export default function stampExtension(
	pi: ExtensionAPI,
	options: StampExtensionOptions = {},
): void {
	const settingsRuntime = options.settingsRuntime ?? createStampSettingsRuntime();
	const now = options.now ?? Date.now;
	pi.registerEntryRenderer(
		STAMP_ENTRY_TYPE,
		createStampEntryRenderer(() => settingsRuntime.get().settings),
	);

	let generation = 0;
	let sessionController = new AbortController();
	let tuiSessionActive = false;
	let lastStampTimestamp: number | undefined;
	let activeAssistantTiming: AssistantTimingObservation | undefined;
	let finalizedAssistantTiming: FinalizedAssistantTiming | undefined;
	let activeThinkingLevel: StampThinkingLevel | undefined;
	const activeToolTimings = new Map<string, ToolTimingObservation>();
	const pendingUserStamps: Array<{ role: "user"; timestamp: number }> = [];

	pi.registerCommand("stamp", {
		description: "Configure transcript timestamp and metadata stamps",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("/stamp does not accept arguments.");
			if (ctx.mode === "print" || ctx.mode === "json") {
				throw new Error(`/stamp is unavailable in ${ctx.mode} mode; use TUI or RPC mode.`);
			}
			const commandGeneration = generation;
			const commandController = sessionController;
			const { showStampMenu } = await import("./menu.js");
			if (
				commandGeneration !== generation ||
				commandController !== sessionController ||
				commandController.signal.aborted
			) {
				return;
			}
			await showStampMenu(ctx, settingsRuntime, {
				signal: commandController.signal,
				isCurrent: () =>
					commandGeneration === generation &&
					commandController === sessionController &&
					!commandController.signal.aborted,
			});
		},
	});

	const appendVersion2Stamp = (role: "user" | "assistant", timestamp: number): void => {
		const stamp: MessageStampDataV2 = {
			version: 2,
			role,
			timestamp,
			...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
		};
		if (!isMessageStampData(stamp)) return;
		pi.appendEntry<MessageStampDataV2>(STAMP_ENTRY_TYPE, stamp);
		lastStampTimestamp = timestamp;
	};

	const appendAssistantStamp = (
		timestamp: number,
		timing: FinalizedAssistantTiming | undefined,
		message: unknown,
		thinkingLevel: StampThinkingLevel | undefined,
	): void => {
		const matchingTiming = timing?.timestamp === timestamp ? timing : undefined;
		const metadata =
			settingsRuntime.get().settings.assistantMetadata === "off"
				? undefined
				: captureAssistantMetadata(message);
		if (metadata && thinkingLevel !== undefined) {
			const stamp: AssistantMessageStampDataV5 = {
				version: 5,
				role: "assistant",
				timestamp,
				...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
				...(matchingTiming
					? {
							completedAt: matchingTiming.completedAt,
							...(matchingTiming.firstContentAt === undefined
								? {}
								: { firstContentAt: matchingTiming.firstContentAt }),
						}
					: {}),
				metadata,
				thinkingLevel,
			};
			if (isMessageStampData(stamp)) {
				pi.appendEntry<AssistantMessageStampDataV5>(STAMP_ENTRY_TYPE, stamp);
				lastStampTimestamp = timestamp;
				return;
			}
		}
		if (metadata) {
			const stamp: AssistantMessageStampDataV4 = {
				version: 4,
				role: "assistant",
				timestamp,
				...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
				...(matchingTiming
					? {
							completedAt: matchingTiming.completedAt,
							...(matchingTiming.firstContentAt === undefined
								? {}
								: { firstContentAt: matchingTiming.firstContentAt }),
						}
					: {}),
				metadata,
			};
			if (isMessageStampData(stamp)) {
				pi.appendEntry<AssistantMessageStampDataV4>(STAMP_ENTRY_TYPE, stamp);
				lastStampTimestamp = timestamp;
				return;
			}
		}
		if (!matchingTiming) {
			appendVersion2Stamp("assistant", timestamp);
			return;
		}
		const stamp: AssistantMessageStampDataV3 = {
			version: 3,
			role: "assistant",
			timestamp,
			...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
			completedAt: matchingTiming.completedAt,
			...(matchingTiming.firstContentAt === undefined
				? {}
				: { firstContentAt: matchingTiming.firstContentAt }),
		};
		if (!isMessageStampData(stamp)) {
			appendVersion2Stamp("assistant", timestamp);
			return;
		}
		pi.appendEntry<AssistantMessageStampDataV3>(STAMP_ENTRY_TYPE, stamp);
		lastStampTimestamp = timestamp;
	};

	const flushPendingUsers = (): void => {
		if (!tuiSessionActive) {
			pendingUserStamps.length = 0;
			return;
		}
		while (pendingUserStamps.length > 0) {
			const stamp = pendingUserStamps[0];
			if (!stamp) break;
			appendVersion2Stamp(stamp.role, stamp.timestamp);
			pendingUserStamps.shift();
		}
	};

	const flushToolStamps = (toolResults: readonly unknown[]): void => {
		try {
			if (!tuiSessionActive || !settingsRuntime.get().settings.toolStamps) return;
			for (const result of toolResults) {
				if (!isRecord(result) || typeof result.toolCallId !== "string") continue;
				const timing = activeToolTimings.get(result.toolCallId);
				if (!timing || timing.completedAt === undefined || timing.outcome === undefined) {
					continue;
				}
				activeToolTimings.delete(result.toolCallId);
				const stamp: ToolStampDataV1 = {
					version: 1,
					kind: "tool",
					toolCallId: timing.toolCallId,
					toolName: timing.toolName,
					startedAt: timing.startedAt,
					completedAt: timing.completedAt,
					outcome: timing.outcome,
				};
				if (isToolStampData(stamp)) pi.appendEntry<ToolStampDataV1>(STAMP_ENTRY_TYPE, stamp);
			}
		} finally {
			activeToolTimings.clear();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionController.abort(new Error("pi-stamp session replaced"));
		sessionController = new AbortController();
		const controller = sessionController;
		const currentGeneration = ++generation;
		pendingUserStamps.length = 0;
		activeAssistantTiming = undefined;
		finalizedAssistantTiming = undefined;
		activeThinkingLevel = undefined;
		activeToolTimings.clear();
		tuiSessionActive = ctx.mode === "tui";
		lastStampTimestamp = lastStampTimestampFromBranch(ctx.sessionManager.getBranch());
		try {
			const state = await settingsRuntime.reload(controller.signal);
			if (
				controller.signal.aborted ||
				currentGeneration !== generation ||
				controller !== sessionController
			) {
				return;
			}
			if (state.issue && ctx.hasUI) {
				ctx.ui.notify(safeTerminalText(state.issue.message), "warning");
			}
		} catch (error) {
			if (controller.signal.aborted) return;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Could not load pi-stamp settings: ${safeTerminalText(formatError(error))}`,
					"warning",
				);
			}
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		activeAssistantTiming = undefined;
		finalizedAssistantTiming = undefined;
		const settings = settingsRuntime.get().settings;
		activeThinkingLevel =
			tuiSessionActive &&
			settings.assistantMetadata !== "off" &&
			settings.showThinkingLevel &&
			isStampThinkingLevel(ctx.thinkingLevel)
				? ctx.thinkingLevel
				: undefined;
		activeToolTimings.clear();
	});

	pi.on("tool_execution_start", (event) => {
		if (
			!tuiSessionActive ||
			!settingsRuntime.get().settings.toolStamps ||
			activeToolTimings.size >= MAX_TOOL_STAMP_OBSERVATIONS ||
			activeToolTimings.has(event.toolCallId) ||
			!isSafePersistedText(event.toolCallId)
		) {
			return;
		}
		const toolName = sanitizeMetadataText(event.toolName);
		if (!toolName) return;
		const startedAt = now();
		if (!isValidTimestamp(startedAt)) return;
		activeToolTimings.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName,
			startedAt,
		});
	});

	pi.on("tool_execution_end", (event) => {
		const timing = activeToolTimings.get(event.toolCallId);
		if (!tuiSessionActive || !timing || timing.completedAt !== undefined) return;
		const completedAt = now();
		if (!isValidTimestamp(completedAt) || completedAt < timing.startedAt) {
			activeToolTimings.delete(event.toolCallId);
			return;
		}
		timing.completedAt = completedAt;
		timing.outcome = event.isError ? "error" : "success";
	});

	pi.on("message_start", (event) => {
		flushPendingUsers();
		if (
			!tuiSessionActive ||
			event.message.role !== "assistant" ||
			!isValidTimestamp(event.message.timestamp)
		) {
			return;
		}
		activeAssistantTiming = { timestamp: event.message.timestamp };
		finalizedAssistantTiming = undefined;
	});

	pi.on("message_update", (event) => {
		if (
			!tuiSessionActive ||
			event.message.role !== "assistant" ||
			!activeAssistantTiming ||
			activeAssistantTiming.timestamp !== event.message.timestamp ||
			activeAssistantTiming.firstContentAt !== undefined ||
			!isMeaningfulAssistantUpdate(event.assistantMessageEvent)
		) {
			return;
		}
		const firstContentAt = now();
		if (isValidTimestamp(firstContentAt)) activeAssistantTiming.firstContentAt = firstContentAt;
	});

	pi.on("message_end", (event) => {
		if (!tuiSessionActive || !isValidTimestamp(event.message.timestamp)) return;
		if (event.message.role === "user") {
			pendingUserStamps.push({ role: "user", timestamp: event.message.timestamp });
			return;
		}
		if (event.message.role !== "assistant") return;
		const completedAt = now();
		if (!isValidTimestamp(completedAt) || completedAt < event.message.timestamp) {
			activeAssistantTiming = undefined;
			finalizedAssistantTiming = undefined;
			return;
		}
		const firstContentAt =
			activeAssistantTiming?.timestamp === event.message.timestamp &&
			isValidTimestamp(activeAssistantTiming.firstContentAt) &&
			activeAssistantTiming.firstContentAt >= event.message.timestamp &&
			activeAssistantTiming.firstContentAt <= completedAt
				? activeAssistantTiming.firstContentAt
				: undefined;
		finalizedAssistantTiming = {
			timestamp: event.message.timestamp,
			completedAt,
			...(firstContentAt === undefined ? {} : { firstContentAt }),
		};
		activeAssistantTiming = undefined;
	});

	pi.on("turn_end", (event) => {
		const timing = finalizedAssistantTiming;
		const thinkingLevel = activeThinkingLevel;
		activeAssistantTiming = undefined;
		finalizedAssistantTiming = undefined;
		activeThinkingLevel = undefined;
		if (tuiSessionActive && event.message.role === "assistant") {
			appendAssistantStamp(event.message.timestamp, timing, event.message, thinkingLevel);
		}
		flushToolStamps(event.toolResults);
	});

	pi.on("agent_end", () => {
		flushPendingUsers();
		activeAssistantTiming = undefined;
		finalizedAssistantTiming = undefined;
		activeThinkingLevel = undefined;
		activeToolTimings.clear();
	});

	pi.on("session_shutdown", async () => {
		sessionController.abort(new Error("pi-stamp session shut down"));
		generation += 1;
		flushPendingUsers();
		pendingUserStamps.length = 0;
		activeAssistantTiming = undefined;
		finalizedAssistantTiming = undefined;
		activeThinkingLevel = undefined;
		activeToolTimings.clear();
		tuiSessionActive = false;
		lastStampTimestamp = undefined;
		await settingsRuntime.flush();
	});
}

function lastStampTimestampFromBranch(entries: readonly unknown[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === STAMP_ENTRY_TYPE &&
			isMessageStampData(entry.data)
		) {
			return entry.data.timestamp;
		}
	}
	return undefined;
}

function isMeaningfulAssistantUpdate(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (
		value.type === "text_delta" ||
		value.type === "thinking_delta" ||
		value.type === "toolcall_delta"
	) {
		return typeof value.delta === "string" && value.delta.length > 0;
	}
	if (value.type === "text_end" || value.type === "thinking_end") {
		return typeof value.content === "string" && value.content.length > 0;
	}
	return value.type === "toolcall_end" && isRecord(value.toolCall);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStampRole(value: unknown): value is MessageStampData["role"] {
	return value === "user" || value === "assistant";
}

function isValidTimestamp(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
	);
}

function isSafePersistedText(value: unknown): value is string {
	return typeof value === "string" && sanitizeMetadataText(value) === value;
}

function safeTerminalText(value: string): string {
	return sanitizeTerminalText(value).trim();
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
