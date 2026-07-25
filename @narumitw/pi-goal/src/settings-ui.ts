import { join } from "node:path";
import {
	type ExtensionCommandContext,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { checkpointGoalActiveTime } from "./accounting.js";
import { abortCurrentTurn, type GoalRuntime, STATUS_KEY } from "./runtime.js";
import { GOAL_SETTINGS_FILE, type GoalSettings, saveGoalSettings } from "./settings.js";

interface GoalSettingsUiOptions {
	settingsPath?: string;
	save?: (settings: GoalSettings, settingsPath: string) => void;
	onQueueUnfrozen?: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface GoalSettingsApplyOptions {
	save?: (settings: GoalSettings) => void;
}

type LimitField = "automaticTurns" | "noProgressTurns";
type SettingsScreenResult =
	| { kind: "limit"; field: LimitField }
	| { kind: "queue"; enabled: boolean }
	| undefined;

export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions = {},
) {
	const settingsPath = options.settingsPath ?? join(getAgentDir(), GOAL_SETTINGS_FILE);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit pi-goal settings manually: ${safeTerminalText(settingsPath)}`, "info");
		return;
	}

	while (true) {
		const result = await showSettingsScreen(runtime, ctx, settingsPath, options);
		if (!result) return;
		if (result.kind === "queue") {
			const next = await nextQueueSettings(runtime, ctx, result.enabled);
			if (!next) return;
			const wasFrozen = runtime.queueFrozen;
			try {
				applyGoalSettings(runtime, next, ctx, {
					save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
				});
				if (wasFrozen && !runtime.queueFrozen) {
					try {
						await options.onQueueUnfrozen?.(ctx);
					} catch (error) {
						ctx.ui.notify(
							`Goal queue enabled, but automatic resume failed: ${formatError(error)}. Reopen /goal to retry.`,
							"warning",
						);
					}
				}
				ctx.ui.notify(`Ordered goal queue: ${result.enabled ? "Experimental" : "Off"}.`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-goal settings save failed: ${formatError(error)}`, "error");
			}
			return;
		}

		const previous = runtime.settings.continuationLimits[result.field];
		const raw = await ctx.ui.input(
			result.field === "automaticTurns" ? "Automatic response limit" : "No-progress run limit",
			formatGoalLimit(previous),
		);
		if (raw === undefined) continue;
		const limit = parseGoalLimit(raw);
		if (limit === undefined) {
			ctx.ui.notify("Enter a positive whole number or Unlimited.", "warning");
			continue;
		}
		const confirmation = await confirmLowerActiveLimit(runtime, ctx, result.field, limit);
		if (!confirmation.apply) continue;
		if (confirmation.goalId !== undefined && runtime.activeGoal?.id !== confirmation.goalId) {
			ctx.ui.notify(
				"The active goal changed while confirming the limit. No settings were changed.",
				"warning",
			);
			continue;
		}
		const next = withLimit(runtime.settings, result.field, limit);
		try {
			applyGoalSettings(runtime, next, ctx, {
				save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
			});
			ctx.ui.notify(
				`${result.field === "automaticTurns" ? "Automatic response" : "No-progress"} limit: ${formatGoalLimit(limit)}.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(`pi-goal settings save failed: ${formatError(error)}`, "error");
		}
	}
}

export function applyGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsApplyOptions = {},
) {
	const snapshot = runtime.snapshotSettingsApplicationState();
	let fileSaved = false;
	try {
		runtime.settings = structuredClone(next);
		applyToolVisibility(runtime, snapshot.settings, next, ctx);
		options.save?.(next);
		fileSaved = options.save !== undefined;
		applyQueueSetting(runtime, ctx);
		const activeGoalId = runtime.activeGoal?.id;
		const abortOwnedRun = activeGoalId !== undefined && runtime.agentRunGoalId === activeGoalId;
		const pausedByAutomaticLimit = runtime.enforceAutomaticTurnLimit(ctx, abortOwnedRun);
		if (!pausedByAutomaticLimit) runtime.enforceNoProgressLimit(ctx, abortOwnedRun);
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		try {
			runtime.restoreSettingsApplicationState(snapshot);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (fileSaved) {
			try {
				options.save?.(snapshot.settings);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				restorePersistedRuntime(runtime, ctx);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`pi-goal settings application failed and rollback was incomplete: ${formatError(error)}`,
			);
		}
		throw error;
	}
}

export function parseGoalLimit(value: string): number | null | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "unlimited" || normalized === "off") return null;
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatGoalLimit(value: number | null) {
	return value === null ? "Unlimited" : String(value);
}

async function showSettingsScreen(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	settingsPath: string,
	options: GoalSettingsUiOptions,
): Promise<SettingsScreenResult> {
	let saveQueue = Promise.resolve();
	const latestRequested = new Map<string, string>();
	return ctx.ui.custom<SettingsScreenResult>((tui, theme, _keybindings, done) => {
		const settings = runtime.settings;
		const items: SettingItem[] = [
			{
				id: "toolVisibility",
				label: "Goal tools",
				description: "Keep terminal Goal tools visible, or reveal them after the first goal.",
				currentValue: visibilityLabel(settings.toolVisibility),
				values: ["Always", "After first goal"],
			},
			{
				id: "experimentalGoals",
				label: "Ordered goal queue",
				description: "Enable experimental add, prioritize, skip, and drop-last workflows.",
				currentValue: settings.experimental.goals ? "Experimental" : "Off",
				values: ["Off", "Experimental"],
			},
			limitItem(
				"automaticTurns",
				"Automatic response limit",
				"Pause after this many Goal-owned automatic model responses.",
				settings.continuationLimits.automaticTurns,
			),
			limitItem(
				"noProgressTurns",
				"No-progress limit",
				"Pause after this many repeated or empty tool-free automatic runs.",
				settings.continuationLimits.noProgressTurns,
			),
		];
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Pi Goal Settings")), 1, 0));
		container.addChild(
			new Text(theme.fg("muted", `User settings · ${safeTerminalText(settingsPath)}`), 1, 0),
		);
		let settingsList: SettingsList;
		let closing = false;
		const closeAfterSaves = (result: SettingsScreenResult) => {
			if (closing) return;
			closing = true;
			void saveQueue.then(() => done(result));
		};
		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				if (closing) return;
				if ((id === "automaticTurns" || id === "noProgressTurns") && newValue === "Edit…") {
					closeAfterSaves({ kind: "limit", field: id });
					return;
				}
				if (id === "experimentalGoals") {
					closeAfterSaves({ kind: "queue", enabled: newValue === "Experimental" });
					return;
				}
				if (id !== "toolVisibility") return;
				latestRequested.set(id, newValue);
				const operation = saveQueue.then(async () => {
					const previousValue = visibilityLabel(runtime.settings.toolVisibility);
					try {
						const next = {
							...structuredClone(runtime.settings),
							toolVisibility: newValue === "Always" ? "always" : "after-first-goal",
						} satisfies GoalSettings;
						applyGoalSettings(runtime, next, ctx, {
							save: (value) => (options.save ?? saveGoalSettings)(value, settingsPath),
						});
						ctx.ui.notify(`Goal tools: ${newValue}.`, "info");
					} catch (error) {
						if (latestRequested.get(id) === newValue) {
							settingsList.updateValue(id, previousValue);
						}
						ctx.ui.notify(`pi-goal settings save failed: ${formatError(error)}`, "error");
						tui.requestRender();
					}
				});
				saveQueue = operation.catch(() => undefined);
			},
			() => closeAfterSaves(undefined),
			{ enableSearch: false },
		);
		container.addChild(settingsList);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate · enter/space change · esc close"), 1, 0),
		);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (closing) return;
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

async function nextQueueSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	enabled: boolean,
) {
	if (runtime.settings.experimental.goals === enabled) return undefined;
	if (enabled && !runtime.settings.experimental.goals) {
		const confirmed = await ctx.ui.confirm(
			"Enable experimental goal queue?",
			"Queue behavior and persisted state may change between releases. Existing single-goal behavior remains available.",
		);
		if (!confirmed) return undefined;
	}
	if (
		!enabled &&
		(runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined) &&
		!(await ctx.ui.confirm(
			"Freeze ordered goal queue?",
			`Disabling the experiment preserves ${retainedGoalCount(runtime)} goal(s) but freezes automatic work until the setting is re-enabled. No goal data will be deleted.`,
		))
	) {
		return undefined;
	}
	return {
		...structuredClone(runtime.settings),
		experimental: { goals: enabled },
	} satisfies GoalSettings;
}

function applyToolVisibility(
	runtime: GoalRuntime,
	previous: GoalSettings,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
) {
	if (previous.toolVisibility === next.toolVisibility) return;
	if (next.toolVisibility === "always") {
		if (runtime.goalToolsHiddenByPolicy.size > 0 && ctx.isIdle() !== true) {
			throw new Error("Wait for Pi to become idle before revealing Goal tools.");
		}
		runtime.restoreGoalToolsHiddenByPolicy();
		runtime.goalToolsUnlocked = true;
		return;
	}
	if (runtime.activeGoal) {
		runtime.goalToolsUnlocked = true;
		runtime.goalToolsHiddenByPolicy.clear();
		return;
	}
	if (ctx.isIdle() !== true) {
		throw new Error("Wait for Pi to become idle before hiding Goal tools.");
	}
	runtime.goalToolsUnlocked = false;
	runtime.hideGoalToolsIfLocked();
}

function applyQueueSetting(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	const hasQueueState = runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined;
	const shouldFreeze = !runtime.settings.experimental.goals && hasQueueState;
	// Keep the freeze guard until the aborted Goal-owned run reaches agent_settled.
	// Releasing it earlier lets the old agent_end pause newly resumed work.
	if (runtime.queueFrozen && !shouldFreeze && runtime.queueFreezeAwaitingSettle) return;
	if (runtime.queueFrozen === shouldFreeze) return;
	const activeGoal = runtime.activeGoal?.status === "active" ? runtime.activeGoal : undefined;
	const goalOwnedRun = activeGoal && runtime.agentRunGoalId === activeGoal.id;
	if (shouldFreeze && activeGoal) {
		if (goalOwnedRun) runtime.recordGoalUsage(activeGoal, ctx, false);
		else {
			const now = Date.now();
			checkpointGoalActiveTime(activeGoal, now, false);
			activeGoal.updatedAt = now;
		}
	}
	runtime.queueFrozen = shouldFreeze;
	if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
	if (shouldFreeze) ctx.ui.setStatus(STATUS_KEY, "queue off");
	else if (runtime.activeGoal) runtime.updateStatus(ctx, runtime.activeGoal);
	else ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!shouldFreeze) return;

	runtime.cancelContinuationWork();
	runtime.clearGoalRecovery();
	runtime.clearBudgetWrapUp();
	if (goalOwnedRun) {
		runtime.blockStaleGoalToolCalls();
		runtime.guardAbortGoalId = activeGoal.id;
		runtime.queueFreezeAwaitingSettle = true;
		runtime.clearAgentRun();
		abortCurrentTurn(ctx);
	}
}

function restorePersistedRuntime(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal) {
		runtime.persistGoal(runtime.activeGoal);
		if (runtime.queueFrozen) ctx.ui.setStatus(STATUS_KEY, "queue off");
		else runtime.updateStatus(ctx, runtime.activeGoal);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function confirmLowerActiveLimit(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	field: LimitField,
	limit: number | null,
) {
	const goal = runtime.activeGoal;
	if (goal?.status !== "active" || limit === null) return { apply: true };
	const used = field === "automaticTurns" ? goal.automaticModelTurns : goal.toolFreeRepeatCount;
	if (used < limit) return { apply: true };
	return {
		apply: await ctx.ui.confirm(
			"Apply reached safety limit?",
			`The active goal has already used ${used}. Setting this limit to ${limit} will pause it immediately without deleting progress.`,
		),
		goalId: goal.id,
	};
}

function withLimit(settings: GoalSettings, field: LimitField, value: number | null): GoalSettings {
	return {
		...structuredClone(settings),
		continuationLimits: { ...settings.continuationLimits, [field]: value },
	};
}

function limitItem(id: LimitField, label: string, description: string, value: number | null) {
	const currentValue = formatGoalLimit(value);
	return {
		id,
		label,
		description,
		currentValue,
		values: [currentValue, "Edit…"],
	} satisfies SettingItem;
}

function visibilityLabel(value: GoalSettings["toolVisibility"]) {
	return value === "always" ? "Always" : "After first goal";
}

function retainedGoalCount(runtime: GoalRuntime) {
	return (
		(runtime.activeGoal ? 1 : 0) +
		runtime.queuedGoals.length +
		(runtime.pendingQueueAction?.kind === "prioritize" ? 1 : 0)
	);
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
