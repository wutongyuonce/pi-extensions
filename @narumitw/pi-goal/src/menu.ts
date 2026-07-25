import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./accounting.js";
import { parseTokenBudget } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import type { ActiveGoal, PendingQueueAction } from "./persistence.js";
import { goalQueueIdentity } from "./queue.js";
import type { GoalRuntime } from "./runtime.js";

export const GOAL_MENU_ACTIONS = {
	start: "Start a goal…",
	startBudget: "Start with token budget…",
	pause: "Pause goal",
	resume: "Resume goal",
	increaseBudget: "Increase budget and resume…",
	edit: "Edit goal…",
	replace: "Replace goal…",
	status: "View full status",
	queue: "Queue…",
	settings: "Settings…",
	help: "Help",
	clear: "Clear goal…",
	close: "Close",
} as const;

const QUEUE_ACTIONS = {
	add: "Add goal…",
	prioritize: "Prioritize goal…",
	skip: "Skip current goal…",
	dropLast: "Drop last goal…",
	back: "Back",
} as const;

interface GoalMenuRuntimeView {
	activeGoal?: ActiveGoal;
	queuedGoals: ActiveGoal[];
	pendingQueueAction?: PendingQueueAction;
	queueFrozen: boolean;
	settings: GoalRuntime["settings"];
	recordGoalUsage?: GoalRuntime["recordGoalUsage"];
	persistGoal?: GoalRuntime["persistGoal"];
	updateStatus?: GoalRuntime["updateStatus"];
}

export interface GoalMenuState {
	title: string;
	actions: string[];
}

type ShowSettings = (ctx: ExtensionCommandContext) => Promise<void>;

export function buildGoalMenuState(runtime: GoalMenuRuntimeView): GoalMenuState {
	const goal = runtime.activeGoal;
	const queueCount = runtime.queuedGoals.length;
	const state = runtime.queueFrozen
		? "Queue frozen"
		: runtime.pendingQueueAction
			? "Waiting for Pi to settle"
			: displayStatus(goal?.status);
	const details = goal
		? [
				goal.tokenBudget === undefined
					? formatDuration(goal.timeUsedSeconds)
					: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`,
				`${goal.automaticModelTurns} automatic responses`,
				...(queueCount > 0 ? [`${queueCount} queued`] : []),
			].join(" · ")
		: "No goal is currently set";
	const title = goal
		? `Goal · ${state}\n${safeGoalMenuText(goal.text)}\n${details}`
		: `Goal · ${state}\n${details}`;

	if (runtime.queueFrozen || runtime.pendingQueueAction) {
		return {
			title,
			actions: [
				GOAL_MENU_ACTIONS.status,
				GOAL_MENU_ACTIONS.settings,
				GOAL_MENU_ACTIONS.help,
				GOAL_MENU_ACTIONS.clear,
				GOAL_MENU_ACTIONS.close,
			],
		};
	}

	const actions: string[] = [];
	if (!goal || goal.status === "complete") {
		actions.push(GOAL_MENU_ACTIONS.start, GOAL_MENU_ACTIONS.startBudget);
	} else if (goal.status === "active") {
		actions.push(GOAL_MENU_ACTIONS.pause);
	} else if (goal.status === "budget_limited") {
		actions.push(GOAL_MENU_ACTIONS.increaseBudget);
	} else {
		actions.push(GOAL_MENU_ACTIONS.resume);
	}
	if (goal && goal.status !== "complete") {
		actions.push(GOAL_MENU_ACTIONS.edit, GOAL_MENU_ACTIONS.replace);
	}
	if (goal) actions.push(GOAL_MENU_ACTIONS.status);
	if (goal && (runtime.settings.experimental.goals || queueCount > 0)) {
		actions.push(GOAL_MENU_ACTIONS.queue);
	}
	actions.push(GOAL_MENU_ACTIONS.settings, GOAL_MENU_ACTIONS.help);
	if (goal) actions.push(GOAL_MENU_ACTIONS.clear);
	actions.push(GOAL_MENU_ACTIONS.close);
	return { title, actions };
}

export async function showGoalManager(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	showSettings: ShowSettings,
): Promise<void> {
	if (ctx.mode !== "tui") {
		commands.showGoal(ctx);
		return;
	}
	while (true) {
		refreshGoalMenuState(runtime, ctx);
		const state = buildGoalMenuState(runtime);
		const displayedGoal = runtime.activeGoal;
		const selected = await ctx.ui.select(state.title, state.actions);
		if (!selected || selected === GOAL_MENU_ACTIONS.close) return;
		switch (selected) {
			case GOAL_MENU_ACTIONS.start:
				await startFromMenu(commands, ctx);
				return;
			case GOAL_MENU_ACTIONS.startBudget:
				await startFromMenu(commands, ctx, true);
				return;
			case GOAL_MENU_ACTIONS.pause:
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) continue;
				commands.pauseGoal(ctx);
				return;
			case GOAL_MENU_ACTIONS.resume:
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) continue;
				await commands.resumeGoal(ctx);
				return;
			case GOAL_MENU_ACTIONS.increaseBudget:
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) continue;
				await increaseBudget(runtime, commands, ctx);
				return;
			case GOAL_MENU_ACTIONS.edit:
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) continue;
				await editFromMenu(runtime, commands, ctx);
				return;
			case GOAL_MENU_ACTIONS.replace:
				await startFromMenu(commands, ctx);
				return;
			case GOAL_MENU_ACTIONS.status:
				commands.showGoal(ctx);
				return;
			case GOAL_MENU_ACTIONS.queue:
				if ((await showQueueMenu(runtime, commands, ctx)) === "back") continue;
				return;
			case GOAL_MENU_ACTIONS.settings:
				await showSettings(ctx);
				continue;
			case GOAL_MENU_ACTIONS.help:
				ctx.ui.notify(goalHelp(), "info");
				return;
			case GOAL_MENU_ACTIONS.clear: {
				const previewedQueue = goalQueueIdentity(
					runtime.activeGoal,
					runtime.queuedGoals,
					runtime.pendingQueueAction,
				);
				if (!(await confirmClear(runtime, ctx))) continue;
				if (
					goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction) !==
					previewedQueue
				) {
					ctx.ui.notify(
						"The goal queue changed while the dialog was open. Reopen /goal and try again.",
						"warning",
					);
					continue;
				}
				commands.clearGoal(ctx);
				return;
			}
		}
	}
}

function refreshGoalMenuState(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goal = runtime.activeGoal;
	if (!goal || runtime.queueFrozen) return;
	runtime.recordGoalUsage?.(goal, ctx);
	runtime.persistGoal?.(goal);
	runtime.updateStatus?.(ctx, goal);
}

export function safeGoalMenuText(value: string, maxCharacters = 120) {
	const sanitized = [...value]
		.map((character) => (isTerminalControl(character) ? " " : character))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...sanitized];
	return characters.length <= maxCharacters
		? sanitized
		: `${characters.slice(0, maxCharacters).join("")}…`;
}

async function startFromMenu(
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	withBudget = false,
) {
	const objective = (await ctx.ui.editor("Goal objective", ""))?.trim();
	if (!objective) return;
	const tokenBudget = withBudget ? await askTokenBudget(ctx) : undefined;
	if (withBudget && tokenBudget === undefined) return;
	await commands.startGoal(objective, tokenBudget, ctx);
}

async function editFromMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const objective = (await ctx.ui.editor("Edit goal objective", goal.text))?.trim();
	if (!objective || objective === goal.text) return;
	if (!requireCurrentMenuGoal(runtime, goal, ctx)) return;
	if (goal.status === "active") {
		const confirmed = await ctx.ui.confirm(
			"Apply goal edit?",
			`Current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\nUpdated goal:\n${safeGoalMenuText(objective, 4_000)}\n\nApplying this edit starts a new guarded goal instance.`,
		);
		if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	}
	await commands.editGoal(objective, undefined, ctx);
}

async function increaseBudget(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const budget = await askTokenBudget(ctx, goal.tokenBudget);
	if (budget === undefined || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	if (budget <= goal.tokensUsed) {
		ctx.ui.notify(
			`Token budget must be greater than current usage (${formatTokenCount(goal.tokensUsed)}).`,
			"warning",
		);
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Increase goal budget?",
		`Goal: ${safeGoalMenuText(goal.text, 4_000)}\n\nBudget: ${formatTokenCount(goal.tokenBudget ?? 0)} → ${formatTokenCount(budget)}\nCurrent usage: ${formatTokenCount(goal.tokensUsed)}\n\nThe goal will resume immediately.`,
	);
	if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	await commands.editGoal(goal.text, budget, ctx);
}

async function askTokenBudget(ctx: ExtensionCommandContext, current?: number) {
	const raw = await ctx.ui.input(
		"Token budget",
		current === undefined ? "100k" : formatTokenCount(current),
	);
	if (raw === undefined) return undefined;
	const budget = parseTokenBudget(raw);
	if (budget === undefined)
		ctx.ui.notify(`Invalid token budget: ${safeGoalMenuText(raw)}`, "warning");
	return budget;
}

async function showQueueMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const actions: string[] = [QUEUE_ACTIONS.add, QUEUE_ACTIONS.prioritize];
	if (runtime.queuedGoals.length > 0) actions.push(QUEUE_ACTIONS.skip, QUEUE_ACTIONS.dropLast);
	actions.push(QUEUE_ACTIONS.back);
	const selected = await ctx.ui.select(
		`Goal queue · ${runtime.queuedGoals.length + 1} total\nCurrent: ${safeGoalMenuText(goal.text)}`,
		actions,
	);
	if (!selected || selected === QUEUE_ACTIONS.back) return "back" as const;
	if (selected === QUEUE_ACTIONS.add) {
		const objective = (await ctx.ui.editor("Add goal to queue", ""))?.trim();
		if (objective) await commands.addGoal(objective, undefined, ctx);
		return;
	}
	if (selected === QUEUE_ACTIONS.prioritize) {
		const objective = (await ctx.ui.editor("Prioritize goal", ""))?.trim();
		if (!objective || !requireCurrentQueueHead(runtime, goal, ctx)) return;
		const confirmed = await ctx.ui.confirm(
			"Prioritize goal?",
			`New priority goal:\n${safeGoalMenuText(objective, 4_000)}\n\nCurrent goal moved to the queue:\n${safeGoalMenuText(goal.text, 4_000)}`,
		);
		if (confirmed && requireCurrentQueueHead(runtime, goal, ctx)) {
			await commands.prioritizeGoal(objective, undefined, ctx);
		}
		return;
	}
	if (selected === QUEUE_ACTIONS.skip) {
		const next = runtime.queuedGoals[0];
		const nextEffect = !next
			? "No goal remains"
			: next.status === "queued"
				? `Start next goal:\n${safeGoalMenuText(next.text, 4_000)}`
				: `Next goal remains ${displayStatus(next.status).toLowerCase()}:\n${safeGoalMenuText(next.text, 4_000)}`;
		const confirmed = await ctx.ui.confirm(
			"Skip current goal?",
			`Remove current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\n${nextEffect}`,
		);
		if (confirmed && requireCurrentQueueSelection(runtime, goal, next, "first", ctx)) {
			await commands.skipGoal(ctx);
		}
		return;
	}
	if (selected === QUEUE_ACTIONS.dropLast) {
		const last = runtime.queuedGoals.at(-1) ?? goal;
		const confirmed = await ctx.ui.confirm(
			"Drop last goal?",
			`Remove from queue:\n${safeGoalMenuText(last.text, 4_000)}`,
		);
		if (confirmed && requireCurrentQueueSelection(runtime, goal, last, "last", ctx)) {
			commands.dropLastGoal(ctx);
		}
	}
}

async function confirmClear(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goals = [runtime.activeGoal, ...runtime.queuedGoals].filter(
		(goal): goal is ActiveGoal => goal !== undefined,
	);
	const pendingPriority =
		runtime.pendingQueueAction?.kind === "prioritize"
			? runtime.pendingQueueAction.objective
			: undefined;
	const summaries = [
		...goals.map((goal) => safeGoalMenuText(goal.text, 4_000)),
		...(pendingPriority ? [`Pending priority: ${safeGoalMenuText(pendingPriority, 4_000)}`] : []),
	];
	if (summaries.length === 0) return false;
	return ctx.ui.confirm(
		summaries.length > 1 ? "Clear goal queue?" : "Clear goal?",
		`Remove ${summaries.length === 1 ? "this goal" : `all ${summaries.length} goals`}:\n\n${summaries
			.map((summary, index) => `${index + 1}. ${summary}`)
			.join("\n")}\n\nThis cannot be undone.`,
	);
}

function requireCurrentQueueHead(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expectedGoal.id) return true;
	ctx.ui.notify(
		"The goal queue changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function requireCurrentQueueSelection(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	expectedQueuedGoal: ActiveGoal | undefined,
	position: "first" | "last",
	ctx: ExtensionCommandContext,
) {
	const currentQueuedGoal =
		position === "first"
			? runtime.queuedGoals[0]
			: (runtime.queuedGoals.at(-1) ?? runtime.activeGoal);
	if (
		runtime.activeGoal?.id === expectedGoal.id &&
		currentQueuedGoal?.id === expectedQueuedGoal?.id
	) {
		return true;
	}
	ctx.ui.notify(
		"The goal queue changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function requireCurrentMenuGoal(
	runtime: GoalMenuRuntimeView,
	expected: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expected.id) return true;
	ctx.ui.notify(
		"The active goal changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function displayStatus(status?: ActiveGoal["status"]) {
	if (!status) return "No goal";
	if (status === "usage_limited") return "Usage limited";
	if (status === "budget_limited") return "Budget limited";
	return status[0]?.toUpperCase() + status.slice(1);
}

function formatTokenCount(tokens: number) {
	return String(tokens);
}

function isTerminalControl(character: string) {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function goalHelp() {
	return [
		"Goal menu",
		"Use the menu for guided status, edits, queue management, settings, and confirmations.",
		"Direct routes remain available for deterministic workflows:",
		"/goal <objective>",
		"/goal status | pause | resume | edit | clear",
		"/goal --tokens 100k <objective>",
		"Escape cancels the current menu or input without changing goal state.",
	].join("\n");
}
