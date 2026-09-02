import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { MenuContext, RunMenuResult } from "@narumitw/pi-tui-kit";
import {
	type BtwSettings,
	type BtwSettingsPatch,
	btwSettingsPath,
	effectiveFullscreenCopyOnSelect,
	effectiveRememberThinkingLevelChanges,
	readBtwSettings,
	type UpdateBtwSettingsOptions,
	updateBtwSettings,
} from "./settings.js";
import { BTW_THINKING_LEVELS, type BtwThinkingLevel } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

interface BtwMenuState {
	kind: "valid" | "invalid";
	settings: BtwSettings;
	reason?: string;
}

export interface BtwResumeThreadSummary {
	id: string;
	title: string;
	questionCount: number;
}

export interface ShowBtwCommandMenuOptions {
	currentThinkingLevel: BtwThinkingLevel;
	availableThinkingLevels: readonly BtwThinkingLevel[];
	resumeThreads?: readonly BtwResumeThreadSummary[];
	settingsPath?: string;
	readSettings?: typeof readBtwSettings;
	updateSettings?: (
		patch: BtwSettingsPatch,
		options: UpdateBtwSettingsOptions,
	) => Promise<BtwSettings>;
}

export type BtwCommandMenuResult =
	| "start"
	| "tree"
	| "closed"
	| { kind: "resume"; threadId: string };

type BtwMenuScreen = "main" | "resume" | "settings" | "invalid";
type BtwMenuAction =
	| "start"
	| "start-tree"
	| "resume"
	| "set-thinking"
	| "set-remember"
	| "set-fullscreen-copy";
const SAME_AS_MAIN_THREAD = "Same as main thread";
type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];

type BtwCustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component;

export async function showBtwCommandMenu(
	ctx: ExtensionCommandContext,
	options: ShowBtwCommandMenuOptions,
): Promise<BtwCommandMenuResult> {
	if (ctx.mode !== "tui") return "closed";
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (ctx.signal?.aborted) return "closed";
	const settingsPath = options.settingsPath ?? btwSettingsPath();
	const readSettings = options.readSettings ?? readBtwSettings;
	const updateSettings = options.updateSettings ?? updateBtwSettings;
	const levels =
		options.availableThinkingLevels.length > 0
			? [...options.availableThinkingLevels]
			: (["off"] satisfies BtwThinkingLevel[]);
	const displaySettingsPath = sanitizeSingleLine(settingsPath);
	const resumeThreads = options.resumeThreads ?? [];
	let startSelected = false;
	let treeSelected = false;
	let resumedThreadId: string | undefined;

	const loadState = async (): Promise<BtwMenuState> => {
		const loaded = await readSettings(settingsPath);
		if (loaded.kind === "invalid") {
			return { kind: "invalid", settings: {}, reason: loaded.reason };
		}
		return { kind: "valid", settings: loaded.kind === "loaded" ? loaded.settings : {} };
	};
	const currentMainThinkingLevel = clampToAvailableThinkingLevel(
		options.currentThinkingLevel,
		levels,
	);
	const displayThinkingLevel = (settings: BtwSettings): string =>
		settings.thinkingLevel === undefined
			? SAME_AS_MAIN_THREAD
			: clampToAvailableThinkingLevel(settings.thinkingLevel, levels);
	const displayThinkingSummary = (settings: BtwSettings): string =>
		settings.thinkingLevel === undefined
			? `${SAME_AS_MAIN_THREAD} (currently ${currentMainThinkingLevel})`
			: displayThinkingLevel(settings);
	const displayRememberSummary = (settings: BtwSettings): string => {
		const value = effectiveRememberThinkingLevelChanges(settings) ? "On" : "Off";
		return settings.thinkingLevel === undefined ? `${value} (fixed levels only)` : value;
	};

	const menu = defineMenu<BtwMenuState, BtwMenuScreen, BtwMenuAction, MenuContext>({
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: "Pi BTW",
				lines: [
					`Thinking: ${displayThinkingSummary(state.settings)} · Remember changes: ${displayRememberSummary(state.settings)}`,
					`Copy on select: ${effectiveFullscreenCopyOnSelect(state.settings) ? "On" : "Off"}`,
				],
				items: [
					{
						id: "start",
						label: "Start side thread",
						description: "Open an empty side thread",
						action: "start",
					},
					{
						id: "start-tree",
						label: "Start from main thread tree…",
						description: "Choose context without switching the main branch",
						action: "start-tree",
					},
					...(resumeThreads.length > 0
						? [
								{
									id: "resume" as const,
									label: "Resume side thread",
									description: "Continue an in-memory side thread",
									to: "resume" as const,
								},
							]
						: []),
					{
						id: "settings",
						label: "Settings",
						description: "Choose thinking, shortcut memory, and selection copying",
						to: state.kind === "invalid" ? "invalid" : "settings",
					},
				],
				hint: "close",
			}),
			resume: () => ({
				kind: "choice",
				title: "Resume BTW side thread",
				enableSearch: true,
				items: resumeThreads.map((thread) => ({
					id: thread.id,
					label: thread.title,
					description: `${thread.questionCount} ${thread.questionCount === 1 ? "question" : "questions"}`,
				})),
				action: "resume",
				viewportSize: 10,
				hint: "back",
			}),
			settings: ({ state }) => ({
				kind: "settings",
				title: "Pi BTW Settings",
				lines: [`User settings · ${displaySettingsPath}`],
				items: [
					{
						id: "thinkingLevel",
						label: "Thinking level",
						description: `Set the starting level for future pi-btw side threads. Currently ${currentMainThinkingLevel}.`,
						currentValue: displayThinkingLevel(state.settings),
						values: [SAME_AS_MAIN_THREAD, ...levels],
						action: "set-thinking",
					},
					{
						id: "rememberThinkingLevelChanges",
						label: "Remember thinking level changes",
						description: "Save shortcut changes for fixed thinking levels to pi-btw.json.",
						currentValue: effectiveRememberThinkingLevelChanges(state.settings) ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-remember",
					},
					{
						id: "fullscreenCopyOnSelect",
						label: "Copy selection automatically",
						description:
							"Copy mouse selections immediately instead of with the configured copy key.",
						currentValue: effectiveFullscreenCopyOnSelect(state.settings) ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-fullscreen-copy",
					},
				],
			}),
			invalid: ({ state }) => ({
				kind: "detail",
				title: "Pi BTW Settings · Read only",
				lines: [
					`Invalid settings file. Fix ${displaySettingsPath} before saving.`,
					sanitizeSingleLine(state.reason ?? "The settings file is invalid."),
				],
				hint: "back",
			}),
		},
		actions: {
			start: async () => {
				startSelected = true;
				return { kind: "close" };
			},
			"start-tree": async () => {
				treeSelected = true;
				return { kind: "close" };
			},
			resume: async ({ itemId }: { itemId: string }) => {
				if (!resumeThreads.some((thread) => thread.id === itemId)) {
					return { kind: "rejected" } as const;
				}
				resumedThreadId = itemId;
				return { kind: "close" } as const;
			},
			"set-thinking": async ({ value, signal }) => {
				if (!value) return { kind: "rejected" };
				const patch =
					value === SAME_AS_MAIN_THREAD
						? ({ thinkingLevel: undefined } satisfies BtwSettingsPatch)
						: levels.includes(value as BtwThinkingLevel)
							? ({ thinkingLevel: value as BtwThinkingLevel } satisfies BtwSettingsPatch)
							: undefined;
				if (!patch) return { kind: "rejected" };
				try {
					await updateSettings(patch, { settingsPath, signal });
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Pi BTW thinking level: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"set-remember": async ({ value, signal }) => {
				if (value !== "On" && value !== "Off") return { kind: "rejected" };
				try {
					await updateSettings(
						{ rememberThinkingLevelChanges: value === "On" },
						{ settingsPath, signal },
					);
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Remember thinking level changes: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"set-fullscreen-copy": async ({ value, signal }) => {
				if (value !== "On" && value !== "Off") return { kind: "rejected" };
				try {
					await updateSettings(
						{ fullscreenCopyOnSelect: value === "On" },
						{ settingsPath, signal },
					);
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Copy selection automatically: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
		},
	});

	const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
		runMenu(menuContext, menu, { getState: loadState }),
	);
	if (result.kind !== "closed" || result.reason !== "close") return "closed";
	if (resumedThreadId) return { kind: "resume", threadId: resumedThreadId };
	if (treeSelected) return "tree";
	return startSelected ? "start" : "closed";
}

export async function showBtwCustomPreservingEditor<T>(
	ctx: ExtensionCommandContext,
	factory: BtwCustomFactory<T>,
): Promise<T | undefined> {
	let liveEditorText = ctx.ui.getEditorText();
	let completed = false;
	const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) =>
		factory(tui, theme, keybindings, (value) => {
			try {
				liveEditorText = ctx.ui.getEditorText();
			} catch {
				// Keep completion finite if session replacement invalidates the editor context.
			}
			completed = true;
			done(value);
		}),
	);
	if (completed) {
		try {
			if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
		} catch {
			// A replaced context owns a different editor and must not receive stale restoration.
		}
	}
	return result;
}

export async function runBtwMenuPreservingEditor(
	ctx: ExtensionCommandContext,
	run: (menuContext: MenuContext) => Promise<RunMenuResult>,
): Promise<RunMenuResult> {
	let liveEditorText = ctx.ui.getEditorText();
	let completed = false;
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "custom") {
				return <Value>(factory: BtwCustomFactory<Value>, customOptions?: BtwCustomOptions) =>
					target.custom<Value>(
						(tui, theme, keybindings, done) =>
							factory(tui, theme, keybindings, (value) => {
								try {
									liveEditorText = target.getEditorText();
								} catch {
									// Keep completion finite if session replacement invalidates the editor context.
								}
								completed = true;
								done(value);
							}),
						customOptions,
					);
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const result = await run({ mode: ctx.mode, hasUI: ctx.hasUI, ui });
	if (result.kind !== "stale" && completed) {
		try {
			if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
		} catch {
			// A replaced context owns a different editor and must not receive stale restoration.
		}
	}
	return result;
}

function clampToAvailableThinkingLevel(
	requested: BtwThinkingLevel,
	available: readonly BtwThinkingLevel[],
): BtwThinkingLevel {
	if (available.includes(requested)) return requested;
	const requestedIndex = BTW_THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < BTW_THINKING_LEVELS.length; index += 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown): void {
	notifySafely(
		ctx,
		`Pi BTW settings were not saved; the previous value remains active: ${formatError(error)}`,
		"error",
	);
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// A completed save remains valid if its command context was replaced before notification.
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
