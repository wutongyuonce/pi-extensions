export const TRIO_STATE_ENTRY = "trio-workflow";

export const TRANSITION_TOOLS = {
	delegate: "trio_delegate_to_executor",
	submit: "trio_submit_for_review",
	revise: "trio_request_changes",
	approve: "trio_approve",
} as const;

export type TransitionToolName = (typeof TRANSITION_TOOLS)[keyof typeof TRANSITION_TOOLS];
export type TrioPhase = "idle" | "planning" | "executing" | "reviewing" | "finalizing";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TrioRoleConfig {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
}

export interface TrioConfig {
	planner: TrioRoleConfig;
	executor: TrioRoleConfig;
	reviewer: TrioRoleConfig;
	maxReviewRounds?: number;
}

export interface ModelReference {
	provider: string;
	model: string;
}

export interface OriginalSessionState {
	model?: ModelReference;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export interface TrioWorkflowState {
	version: 1;
	active: boolean;
	phase: TrioPhase;
	task: string;
	reviewRound: number;
	original: OriginalSessionState;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const TRANSITION_TOOL_NAMES = new Set<string>(Object.values(TRANSITION_TOOLS));
const READ_ONLY_TOOL_NAMES = ["read", "bash", "grep", "find", "ls"];
const EXECUTION_TOOL_NAMES = ["read", "bash", "edit", "write"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRoleConfig(value: unknown, fallback: TrioRoleConfig | undefined, label: string): TrioRoleConfig {
	if (value !== undefined && !isRecord(value)) throw new Error(`${label} must be an object`);
	const role = value ?? {};
	const provider = role.provider ?? fallback?.provider;
	const model = role.model ?? fallback?.model;
	const thinkingLevel = role.thinkingLevel ?? fallback?.thinkingLevel;
	const systemPrompt = role.systemPrompt ?? fallback?.systemPrompt;

	if (typeof provider !== "string" || provider.trim() === "") {
		throw new Error(`${label}.provider must be a non-empty string`);
	}
	if (typeof model !== "string" || model.trim() === "") {
		throw new Error(`${label}.model must be a non-empty string`);
	}
	if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel))) {
		throw new Error(`${label}.thinkingLevel must be one of ${Array.from(THINKING_LEVELS).join(", ")}`);
	}
	if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
		throw new Error(`${label}.systemPrompt must be a string`);
	}

	return {
		provider: provider.trim(),
		model: model.trim(),
		...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
	};
}

export function mergeTrioConfig(base: TrioConfig | undefined, value: unknown, source: string): TrioConfig {
	if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);

	const maxReviewRounds = value.maxReviewRounds ?? base?.maxReviewRounds;
	if (
		maxReviewRounds !== undefined &&
		(!Number.isInteger(maxReviewRounds) || (maxReviewRounds as number) < 0 || (maxReviewRounds as number) > 20)
	) {
		throw new Error(`${source}.maxReviewRounds must be an integer between 0 and 20`);
	}

	return {
		planner: readRoleConfig(value.planner, base?.planner, `${source}.planner`),
		executor: readRoleConfig(value.executor, base?.executor, `${source}.executor`),
		reviewer: readRoleConfig(value.reviewer, base?.reviewer, `${source}.reviewer`),
		...(maxReviewRounds === undefined ? {} : { maxReviewRounds: maxReviewRounds as number }),
	};
}

function uniqueAvailable(names: string[], availableTools: Set<string>): string[] {
	return [...new Set(names)].filter((name) => availableTools.has(name));
}

export function getToolsForPhase(
	phase: TrioPhase,
	originalTools: string[],
	availableToolNames: string[],
): string[] {
	const availableTools = new Set(availableToolNames);
	const originalWithoutTransitions = originalTools.filter((name) => !TRANSITION_TOOL_NAMES.has(name));

	if (phase === "idle") return uniqueAvailable(originalWithoutTransitions, availableTools);

	if (phase === "executing") {
		return uniqueAvailable(
			[...originalWithoutTransitions, ...EXECUTION_TOOL_NAMES, TRANSITION_TOOLS.submit],
			availableTools,
		);
	}

	const readOnlyBase = originalWithoutTransitions.filter((name) => name !== "edit" && name !== "write");
	if (phase === "planning") {
		return uniqueAvailable([...readOnlyBase, ...READ_ONLY_TOOL_NAMES, TRANSITION_TOOLS.delegate], availableTools);
	}
	if (phase === "reviewing") {
		return uniqueAvailable(
			[...readOnlyBase, ...READ_ONLY_TOOL_NAMES, TRANSITION_TOOLS.revise, TRANSITION_TOOLS.approve],
			availableTools,
		);
	}

	return uniqueAvailable([...readOnlyBase, ...READ_ONLY_TOOL_NAMES], availableTools);
}

function appendRoleSystemPrompt(instructions: string, systemPrompt: string): string {
	if (!systemPrompt.trim()) return instructions;
	return `${instructions}\n\n[TRIO ROLE SYSTEM PROMPT]\n${systemPrompt.trim()}`;
}

export function getPhaseInstructions(state: TrioWorkflowState, config: TrioConfig): string | undefined {
	if (!state.active) return undefined;

	if (state.phase === "planning") {
		return appendRoleSystemPrompt(`[TRIO PHASE: PLANNING]
You are the planner and orchestrator. Understand the request, inspect the codebase as needed, and produce a concrete implementation plan for the executor.
Do not edit files. When the plan is ready, call ${TRANSITION_TOOLS.delegate} with the task, ordered plan, acceptance criteria, and relevant files.
The transition tool must be the only tool call in that response. Do not give the user a final answer instead of delegating.

Original task:
${state.task}`, config.planner.systemPrompt ?? "");
	}

	if (state.phase === "executing") {
		return appendRoleSystemPrompt(`[TRIO PHASE: EXECUTION]
You are the executor. Implement the delegated plan in the current working tree, using the conversation and tool results as shared context.
Run relevant tests or checks. When implementation is complete or blocked, call ${TRANSITION_TOOLS.submit} with a factual summary, tests run, and unresolved issues.
The transition tool must be the only tool call in that response. Do not provide the final user-facing answer.`, config.executor.systemPrompt ?? "");
	}

	if (state.phase === "reviewing") {
		const round = config.maxReviewRounds === undefined ? `${state.reviewRound}` : `${state.reviewRound}/${config.maxReviewRounds}`;
		return appendRoleSystemPrompt(`[TRIO PHASE: REVIEW — round ${round}]
You are the reviewer. Independently review the executor's work and available validation evidence; do not rely only on the executor summary.
Do not edit files yourself. If changes are needed, call ${TRANSITION_TOOLS.revise}. Otherwise call ${TRANSITION_TOOLS.approve} and clearly record any remaining concerns.
The transition tool must be the only tool call in that response.`, config.reviewer.systemPrompt ?? "");
	}

	if (state.phase === "finalizing") {
		return appendRoleSystemPrompt(`[TRIO PHASE: FINAL RESPONSE]
The implementation has been reviewed and approved. Give the user the final concise summary, including changes made, validation run, and any remaining caveats.
Do not call additional Trio transition tools.`, config.planner.systemPrompt ?? "");
	}

	return undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

function parsePersistedState(value: unknown): TrioWorkflowState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (typeof value.active !== "boolean" || typeof value.task !== "string") return undefined;
	if (!Number.isInteger(value.reviewRound) || (value.reviewRound as number) < 0) return undefined;
	if (!["idle", "planning", "executing", "reviewing", "finalizing"].includes(String(value.phase))) return undefined;
	if (!isRecord(value.original) || !Array.isArray(value.original.tools)) return undefined;
	if (!value.original.tools.every((tool) => typeof tool === "string")) return undefined;
	if (!isThinkingLevel(value.original.thinkingLevel)) return undefined;

	let model: ModelReference | undefined;
	if (value.original.model !== undefined) {
		if (!isRecord(value.original.model)) return undefined;
		if (typeof value.original.model.provider !== "string" || typeof value.original.model.model !== "string") {
			return undefined;
		}
		model = {
			provider: value.original.model.provider,
			model: value.original.model.model,
		};
	}

	return {
		version: 1,
		active: value.active,
		phase: value.phase as TrioPhase,
		task: value.task,
		reviewRound: value.reviewRound as number,
		original: {
			model,
			thinkingLevel: value.original.thinkingLevel,
			tools: [...value.original.tools],
		},
	};
}

export function readLatestWorkflowState(
	entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): TrioWorkflowState | undefined {
	let latest: TrioWorkflowState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TRIO_STATE_ENTRY) continue;
		const parsed = parsePersistedState(entry.data);
		if (parsed) latest = parsed;
	}
	return latest;
}
