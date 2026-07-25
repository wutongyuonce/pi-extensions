import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "../src/settings.js";
import {
	applyGoalSettings,
	formatGoalLimit,
	parseGoalLimit,
	showGoalSettings,
} from "../src/settings-ui.js";

initTheme("dark", false);

function runtime() {
	const mock = createMockPi({ activeTools: ["read"] });
	const state = new GoalRuntime(mock.pi) as GoalRuntime & {
		readonly visibility: ReturnType<GoalRuntime["snapshotGoalToolVisibility"]>;
	};
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	state.goalToolsHiddenByPolicy.add("goal_complete");
	state.goalToolsHiddenByPolicy.add("goal_blocked");
	Object.defineProperty(state, "visibility", {
		get: () => state.snapshotGoalToolVisibility(),
	});
	return state;
}

test("goal setting limit parsing preserves arbitrary positive integers and unlimited", () => {
	assert.equal(parseGoalLimit("40"), 40);
	assert.equal(parseGoalLimit("unlimited"), null);
	assert.equal(parseGoalLimit("off"), null);
	for (const invalid of ["", "0", "-1", "1.5", "many"]) {
		assert.equal(parseGoalLimit(invalid), undefined);
	}
	assert.equal(formatGoalLimit(25), "25");
	assert.equal(formatGoalLimit(null), "Unlimited");
});

test("applyGoalSettings saves before committing runtime settings and enforces lower limits", () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	let enforced = 0;
	state.enforceAutomaticTurnLimit = () => {
		enforced++;
		return false;
	};
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 10, noProgressTurns: 2 },
	};
	const context = createMockContext();

	applyGoalSettings(state as never, next, context.ctx, {
		save(settings: GoalSettings) {
			saved = structuredClone(settings);
		},
	});

	assert.deepEqual(saved, next);
	assert.deepEqual(state.settings, next);
	assert.equal(enforced, 1);
});

test("applyGoalSettings restores effective tool policy when persistence fails", () => {
	const state = runtime();
	const before = structuredClone(state.visibility);
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "always",
	};
	const context = createMockContext();

	assert.throws(
		() =>
			applyGoalSettings(state as never, next, context.ctx, {
				save() {
					throw new Error("disk full");
				},
			}),
		/disk full/,
	);
	assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(state.visibility, before);
});

test("applyGoalSettings rolls back file and effective state after runtime application fails", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	const previous = structuredClone(state.settings);
	const next = { ...structuredClone(previous), experimental: { goals: false } };
	const saved: GoalSettings[] = [];
	let persistCalls = 0;
	state.persistGoal = () => {
		persistCalls++;
		if (persistCalls === 1) throw new Error("stale context");
	};
	const context = createMockContext({ mode: "tui", hasUI: true });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save(settings) {
					saved.push(structuredClone(settings));
				},
			}),
		/stale context/,
	);
	assert.deepEqual(saved, [next, previous]);
	assert.deepEqual(state.settings, previous);
	assert.equal(state.queueFrozen, false);
	assert.equal(state.activeGoal?.status, "active");
});

test("disabling a retained queue pauses and aborts in-flight Goal work", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.requestContinuation(state.activeGoal);
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 1);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.activeGoal?.status, "active");
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.continuationIntent, undefined);
	assert.equal(state.staleGoalToolCallsBlocked, true);
});

test("freezing a queue preserves an unrelated in-flight run", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 0);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.guardAbortGoalId, undefined);
	assert.equal(state.queueFreezeAwaitingSettle, false);
	assert.equal(state.staleGoalToolCallsBlocked, false);
});

test("revealing lazy Goal tools rejects a busy unrelated run", () => {
	const state = runtime();
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "after-first-goal",
	};
	const before = structuredClone(state.visibility);
	const next = { ...structuredClone(state.settings), toolVisibility: "always" as const };
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save() {
					saves++;
				},
			}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "after-first-goal");
	assert.deepEqual(state.visibility, before);
});

test("hiding always-visible Goal tools rejects a busy unrelated run", () => {
	const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	const before = state.snapshotGoalToolVisibility();
	const next = {
		...structuredClone(state.settings),
		toolVisibility: "after-first-goal" as const,
	};
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save() {
					saves++;
				},
			}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "always");
	assert.deepEqual(state.snapshotGoalToolVisibility(), before);
});

test("lowering the no-progress limit pauses and aborts in-flight Goal work", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
	};

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 1);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("lowering a reached limit preserves an unrelated in-flight run", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
	};

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 0);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("replacement confirmation does not replace a goal that changed while open", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("previewed objective", undefined, 0);
	const replacement = createGoal("replacement objective", undefined, 0);
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async () => {
			state.activeGoal = replacement;
			return true;
		},
	});
	const controller = new GoalCommandController(state);

	await controller.startGoal("new objective", undefined, context.ctx);

	assert.equal(state.activeGoal?.id, replacement.id);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal queue changed.*try again/i);
});

test("replacement confirmation sanitizes terminal controls without changing goal data", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("current\u001b]8;;bad\u0007 objective", undefined, 0);
	state.queuedGoals = [createGoal("queued\u001b objective", undefined, 0)];
	let preview = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async (_title: string, message: string) => {
			preview = message;
			return false;
		},
	});
	const controller = new GoalCommandController(state);

	await controller.startGoal("new\u009b31m objective", undefined, context.ctx);

	for (const control of ["\u0007", "\u001b", "\u009b"]) {
		assert.equal(preview.includes(control), false);
	}
	assert.match(preview, /Current goal: current ]8;;bad objective/);
	assert.match(preview, /Queued goals also removed:\n1\. queued objective/);
	assert.match(preview, /New goal: new 31m objective/);
	assert.equal(state.activeGoal?.text, "current\u001b]8;;bad\u0007 objective");
});

test("unfreezing waits for an aborted frozen run to settle before dispatching", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: false },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(state.activeGoal.id, "manual");
	state.queueFrozen = true;
	state.guardAbortGoalId = state.activeGoal.id;
	state.queueFreezeAwaitingSettle = true;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });
	const enabled = { ...structuredClone(state.settings), experimental: { goals: true } };
	const controller = new GoalCommandController(state);

	applyGoalSettings(state, enabled, context.ctx, { save() {} });
	const dispatchedEarly = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatchedEarly, false);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.guardAbortGoalId, state.activeGoal.id);
	assert.equal(mock.sentUserMessages.length, 0);

	state.clearSettledSafetyTracking();
	state.queueFreezeAwaitingSettle = false;
	const dispatchedAfterSettle = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatchedAfterSettle, true);
	assert.equal(state.queueFrozen, false);
	assert.equal(typeof state.activeGoal?.activeStartedAt, "number");
	assert.equal(mock.sentUserMessages.length, 1);
});

test("unfreezing an active retained queue dispatches Goal work immediately", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.queueFrozen = false;
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatched, true);
	assert.equal(mock.sentUserMessages.length, 1);
	assert.match(mock.sentUserMessages[0]?.text ?? "", /Continue the active \/goal/i);
});

test("unfreezing a pending priority dispatches it at the idle boundary", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.pendingQueueAction = { kind: "prioritize", objective: "urgent objective" };
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatched, true);
	assert.equal(state.pendingQueueAction, undefined);
	assert.equal(state.activeGoal?.text, "urgent objective");
	assert.equal(mock.sentUserMessages.length, 1);
});

test("settings screen saves changes in place and Escape waits for the save queue", async () => {
	const state = runtime();
	const saved: GoalSettings[] = [];
	let initialRender = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const selector = createCustomSelectorHarness(factory, 40);
			initialRender = selector.render().join("\n");
			selector.handleInput("\r");
			selector.handleInput("\u001b");
			selector.handleInput("\r");
			await new Promise((resolve) => setImmediate(resolve));
			return selector.result;
		},
	});

	await showGoalSettings(state as never, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved.push(structuredClone(settings));
		},
	});

	assert.match(initialRender, /Pi Goal Settings/);
	assert.match(initialRender, /Goal tools/);
	assert.doesNotMatch(initialRender, /Type to search/);
	assert.equal(saved.length, 1);
	assert.equal(saved[0]?.toolVisibility, "after-first-goal");
	assert.equal(state.settings.toolVisibility, "after-first-goal");
});

test("lowered limit confirmation cannot apply to a replacement goal", async () => {
	const state = runtime();
	const original = createGoal("original objective", undefined, 0);
	original.automaticModelTurns = 5;
	state.activeGoal = original;
	const replacement = createGoal("replacement objective", undefined, 0);
	replacement.automaticModelTurns = 5;
	const saved: GoalSettings[] = [];
	let screens = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		input: async () => "3",
		confirm: async () => {
			state.activeGoal = replacement;
			return true;
		},
		custom: async (factory: unknown) => {
			const selector = createCustomSelectorHarness(factory, 80);
			if (screens++ === 0) {
				selector.handleInput("\u001b[B");
				selector.handleInput("\u001b[B");
				selector.handleInput("\r");
			} else {
				selector.handleInput("\u001b");
			}
			await new Promise((resolve) => setImmediate(resolve));
			return selector.result;
		},
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved.push(structuredClone(settings));
		},
	});

	assert.equal(saved.length, 0);
	assert.equal(
		state.settings.continuationLimits.automaticTurns,
		DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
	);
	assert.equal(state.activeGoal?.id, replacement.id);
	assert.equal(state.activeGoal?.status, "active");
	assert.match(context.notifications.at(-1)?.message ?? "", /goal changed/i);
});

test("full goal status includes a pending priority objective", () => {
	const state = runtime();
	state.settings.experimental.goals = true;
	state.activeGoal = createGoal("current objective", undefined, 0);
	const queued = createGoal("queued objective", undefined, 0);
	queued.status = "queued";
	state.queuedGoals = [queued];
	state.pendingQueueAction = { kind: "prioritize", objective: "urgent objective" };
	const context = createMockContext({ mode: "tui", hasUI: true });

	new GoalCommandController(state).showGoal(context.ctx);

	const summary = context.notifications.at(-1)?.message ?? "";
	assert.match(summary, /Goals \(3\):/);
	assert.match(summary, /1\. \[active\] current objective/);
	assert.match(summary, /2\. \[pending\] urgent objective/);
	assert.match(summary, /3\. \[queued\] queued objective/);
});

test("queue confirmations open only after the custom settings screen closes", async () => {
	for (const scenario of ["enable", "disable"] as const) {
		const state = runtime();
		if (scenario === "disable") {
			state.settings.experimental.goals = true;
			state.activeGoal = createGoal("current objective", undefined, 0);
			state.queuedGoals = [createGoal("queued objective", undefined, 0)];
			state.pendingQueueAction = { kind: "prioritize", objective: "urgent objective" };
		}
		let customActive = false;
		let confirmedWhileCustom = false;
		let confirmationMessage = "";
		let screens = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async (_title: string, message: string) => {
				confirmedWhileCustom ||= customActive;
				confirmationMessage = message;
				return false;
			},
			custom: async (factory: unknown) => {
				customActive = true;
				const selector = createCustomSelectorHarness(factory, 80);
				if (screens++ === 0) {
					selector.handleInput("\u001b[B");
					selector.handleInput("\r");
				} else {
					selector.handleInput("\u001b");
				}
				await new Promise((resolve) => setImmediate(resolve));
				customActive = false;
				return selector.result;
			},
		});

		await showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save() {},
		});

		assert.equal(confirmedWhileCustom, false, scenario);
		assert.equal(state.settings.experimental.goals, scenario === "disable");
		if (scenario === "disable") assert.match(confirmationMessage, /preserves 3 goal\(s\)/i);
	}
});

test("settings screen resumes retained work after enabling the queue", async () => {
	const state = runtime();
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.queueFrozen = true;
	let unfrozen = 0;
	let screens = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async () => true,
		custom: async (factory: unknown) => {
			const selector = createCustomSelectorHarness(factory, 80);
			if (screens++ === 0) {
				selector.handleInput("\u001b[B");
				selector.handleInput("\r");
			} else {
				selector.handleInput("\u001b");
			}
			await new Promise((resolve) => setImmediate(resolve));
			return selector.result;
		},
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {},
		onQueueUnfrozen: async () => {
			unfrozen++;
		},
	});

	assert.equal(state.queueFrozen, false);
	assert.equal(state.settings.experimental.goals, true);
	assert.equal(unfrozen, 1);
	assert.equal(screens, 1);
});

test("settings screen fits narrow, normal, and wide terminal widths", async () => {
	for (const width of [40, 80, 120]) {
		const state = runtime();
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const selector = createCustomSelectorHarness(factory, width);
				const lines = selector.render();
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				selector.handleInput("\u001b");
				await new Promise((resolve) => setImmediate(resolve));
				return selector.result;
			},
		});
		await showGoalSettings(state as never, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save() {
				throw new Error("Escape must not save.");
			},
		});
	}
});

test("showGoalSettings uses an observable manual fallback outside TUI", async () => {
	const state = runtime();
	const context = createMockContext({ mode: "rpc", hasUI: true });
	await showGoalSettings(state as never, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(context.notifications[0]?.message ?? "", /edit pi-goal settings manually/i);
	assert.match(context.notifications[0]?.message ?? "", /\/tmp\/pi-goal\.json/);
});
