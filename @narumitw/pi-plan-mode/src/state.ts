import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planFromCompletionDetails,
} from "./completion-tool.js";
import { PLAN_MODE_THINKING_LEVELS, type PlanModeFixedThinkingLevel } from "./settings.js";

export type PlanCompletionSource = typeof PLAN_MODE_COMPLETE_TOOL_NAME | "legacy_proposed_plan";

export interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	latestPlanSource?: PlanCompletionSource;
	awaitingAction: boolean;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
	previousThinkingLevel?: PlanModeFixedThinkingLevel;
	appliedThinkingLevel?: PlanModeFixedThinkingLevel;
	manualThinkingLevel?: PlanModeFixedThinkingLevel;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
};

export function restorePlanModeState(entries: unknown[], stateEntryType: string): PlanModeState {
	const branch = entries as SessionEntry[];
	let stateEntryIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === stateEntryType) {
			stateEntryIndex = index;
			break;
		}
	}
	const entry = branch[stateEntryIndex];
	if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

	const enabled = entry.data.enabled === true;
	const persistedSource = enabled ? planCompletionSource(entry.data.latestPlanSource) : undefined;
	const persistedPlan = enabled
		? normalizePersistedPlan(entry.data.latestPlan, persistedSource)
		: undefined;
	const recoveredPlan =
		enabled && !persistedPlan ? latestCompletionPlan(branch.slice(stateEntryIndex + 1)) : undefined;
	const latestPlan = persistedPlan ?? recoveredPlan;
	return {
		enabled,
		latestPlan,
		latestPlanSource: enabled
			? ((persistedPlan ? persistedSource : undefined) ??
				(recoveredPlan ? PLAN_MODE_COMPLETE_TOOL_NAME : undefined))
			: undefined,
		awaitingAction: enabled && latestPlan !== undefined,
		selectedToolNames: stringArray(entry.data.selectedToolNames),
		selectedToolKeys: stringArray(entry.data.selectedToolKeys),
		previousThinkingLevel: enabled
			? fixedThinkingLevel(entry.data.previousThinkingLevel)
			: undefined,
		appliedThinkingLevel: enabled ? fixedThinkingLevel(entry.data.appliedThinkingLevel) : undefined,
		manualThinkingLevel: enabled ? fixedThinkingLevel(entry.data.manualThinkingLevel) : undefined,
	};
}

function normalizePersistedPlan(value: unknown, source: PlanCompletionSource | undefined) {
	if (typeof value !== "string") return undefined;
	if (source === PLAN_MODE_COMPLETE_TOOL_NAME) {
		const normalized = normalizePlanModeCompletion({ plan: value });
		return normalized.ok ? normalized.plan : undefined;
	}
	return value.trim() || undefined;
}

function latestCompletionPlan(entries: SessionEntry[]) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.toolName !== PLAN_MODE_COMPLETE_TOOL_NAME) {
			continue;
		}
		const plan = planFromCompletionDetails(message.details);
		if (plan) return plan;
	}
	return undefined;
}

function planCompletionSource(value: unknown): PlanCompletionSource | undefined {
	return value === PLAN_MODE_COMPLETE_TOOL_NAME || value === "legacy_proposed_plan"
		? value
		: undefined;
}

function fixedThinkingLevel(value: unknown): PlanModeFixedThinkingLevel | undefined {
	return typeof value === "string" &&
		value !== "inherit" &&
		PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])
		? (value as PlanModeFixedThinkingLevel)
		: undefined;
}

function stringArray(value: unknown) {
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
		? Array.from(new Set(value))
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
