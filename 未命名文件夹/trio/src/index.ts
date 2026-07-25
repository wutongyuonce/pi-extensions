import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	TRIO_STATE_ENTRY,
	getPhaseInstructions,
	getToolsForPhase,
	mergeTrioConfig,
	readLatestWorkflowState,
	TRANSITION_TOOLS,
	type TrioConfig,
	type TrioPhase,
	type TrioRoleConfig,
	type TrioWorkflowState,
	type OriginalSessionState,
} from "./core.ts";

const CONFIG_FILE_NAME = "trio.json";
const TRANSITION_TOOL_NAMES = new Set<string>(Object.values(TRANSITION_TOOLS));

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadConfig(ctx: ExtensionContext): { config: TrioConfig | undefined; paths: string[] } {
	let config: TrioConfig | undefined;
	const paths: string[] = [];
	const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

	if (existsSync(globalPath)) {
		config = mergeTrioConfig(undefined, readJsonFile(globalPath), globalPath);
		paths.push(globalPath);
	}
	if (ctx.isProjectTrusted() && existsSync(projectPath)) {
		config = mergeTrioConfig(config, readJsonFile(projectPath), projectPath);
		paths.push(projectPath);
	}

	return { config, paths };
}

function getToolCallCount(ctx: ExtensionContext, toolCallId: string): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.filter((content) => content.type === "toolCall");
		if (calls.some((call) => call.id === toolCallId)) return calls.length;
	}
	return undefined;
}

function phaseLabel(phase: TrioPhase): string {
	if (phase === "planning") return "planner";
	if (phase === "executing") return "executor";
	if (phase === "reviewing") return "review";
	if (phase === "finalizing") return "finalizing";
	return "idle";
}

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	return `${Math.round(tokens / 1_000)}K`;
}

function formatModelOption(model: Model<any>, currentModelKey?: string): string {
	const details: string[] = [];
	if (model.name && model.name !== model.id) details.push(model.name);
	if (model.reasoning) details.push("reasoning");
	details.push(`${formatTokenCount(model.contextWindow)} context`);
	if (modelKey(model) === currentModelKey) details.push("current");
	return `${modelKey(model)} — ${details.join(" · ")}`;
}

function modelSearchText(model: Model<any>): string {
	return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
}

async function chooseModel(
	ctx: ExtensionContext,
	models: Model<any>[],
	title: string,
): Promise<Model<any> | undefined> {
	const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
	const sorted = [...models].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));

	// Non-interactive fallback (RPC etc.): a plain select list.
	if (ctx.mode !== "tui") {
		const optionToModel = new Map(sorted.map((model) => [formatModelOption(model, currentKey), model]));
		const selected = await ctx.ui.select(title, [...optionToModel.keys()]);
		return selected ? optionToModel.get(selected) : undefined;
	}

	const result = await ctx.ui.custom<Model<any> | null>((tui, theme, _kb, done) => {
		const maxVisible = 10;
		const search = new Input();
		search.focused = true;
		const listContainer = new Container();
		let filtered = sorted;
		let selectedIndex = 0;

		function renderList(): void {
			listContainer.clear();
			if (filtered.length === 0) {
				listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
				return;
			}
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
			const end = Math.min(start + maxVisible, filtered.length);
			for (let index = start; index < end; index++) {
				const model = filtered[index];
				const isSelected = index === selectedIndex;
				const key = modelKey(model);
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const label = isSelected ? theme.fg("accent", key) : key;
				const name = model.name && model.name !== model.id ? theme.fg("muted", ` — ${model.name}`) : "";
				const current = key === currentKey ? theme.fg("success", " ✓") : "";
				listContainer.addChild(new Text(`${prefix}${label}${name}${current}`, 0, 0));
			}
			if (start > 0 || end < filtered.length) {
				listContainer.addChild(new Text(theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length})`), 0, 0));
			}
		}

		function applyFilter(): void {
			const query = search.getValue().trim();
			filtered = query ? fuzzyFilter(sorted, query, modelSearchText) : sorted;
			selectedIndex = 0;
			renderList();
		}

		const container = new Container();
		const border = () => new DynamicBorder((line: string) => theme.fg("accent", line));
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(search);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "type to search · ↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(border());

		renderList();

		const kb = getKeybindings();
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (kb.matches(data, "tui.select.up")) {
					if (filtered.length > 0) {
						selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
						renderList();
					}
				} else if (kb.matches(data, "tui.select.down")) {
					if (filtered.length > 0) {
						selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
						renderList();
					}
				} else if (kb.matches(data, "tui.select.confirm")) {
					const model = filtered[selectedIndex];
					if (model) done(model);
				} else if (kb.matches(data, "tui.select.cancel")) {
					done(null);
				} else {
					search.handleInput(data);
					applyFilter();
				}
				tui.requestRender();
			},
		};
	});

	return result ?? undefined;
}

export default function trioExtension(pi: ExtensionAPI) {
	let config: TrioConfig | undefined;
	let configPaths: string[] = [];
	let state: TrioWorkflowState | undefined;
	let toolsRegistered = false;
	// Phase framing is injected once per phase entry, not every turn. Re-injecting
	// each turn makes the model re-narrate its role ("I'm the executor…") endlessly.
	let announcedPhaseKey: string | undefined;

	function requireConfig(): TrioConfig {
		if (!config) throw new Error("Trio is not configured. Run /trio setup.");
		return config;
	}

	async function runOnboarding(ctx: ExtensionContext): Promise<TrioConfig | undefined> {
		const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
		if (!ctx.hasUI) {
			ctx.ui.notify(`Trio needs interactive setup. Run /trio setup in the TUI, or create ${configPath}.`, "error");
			return undefined;
		}

		const models = await ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("No authenticated models are available. Configure a model with /login first.", "error");
			return undefined;
		}

		const planner = await chooseModel(ctx, models, "Trio setup: choose the planner model");
		if (!planner) {
			ctx.ui.notify("Trio setup cancelled.", "info");
			return undefined;
		}
		const executor = await chooseModel(ctx, models, "Trio setup: choose the executor model");
		if (!executor) {
			ctx.ui.notify("Trio setup cancelled.", "info");
			return undefined;
		}

		const usePlannerOption = `Use planner as reviewer (${modelKey(planner)})`;
		const customReviewerOption = "Select a custom reviewer model";
		const reviewerChoice = await ctx.ui.select("Trio setup: choose the reviewer", [
			usePlannerOption,
			customReviewerOption,
		]);
		if (!reviewerChoice) {
			ctx.ui.notify("Trio setup cancelled.", "info");
			return undefined;
		}
		let reviewer = planner;
		if (reviewerChoice === customReviewerOption) {
			const selectedReviewer = await chooseModel(ctx, models, "Trio setup: choose the reviewer model");
			if (!selectedReviewer) {
				ctx.ui.notify("Trio setup cancelled.", "info");
				return undefined;
			}
			reviewer = selectedReviewer;
		}

		const selectedConfig: TrioConfig = {
			planner: { provider: planner.provider, model: planner.id },
			executor: { provider: executor.provider, model: executor.id },
			reviewer: { provider: reviewer.provider, model: reviewer.id },
		};
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(selectedConfig, null, 2)}\n`, "utf8");
		config = selectedConfig;
		configPaths = [configPath];
		ctx.ui.notify(
			`Trio setup complete.\nPlanner: ${modelKey(planner)}\nExecutor: ${modelKey(executor)}\nReviewer: ${modelKey(reviewer)}\nSaved to ${configPath}. Edit the configuration there or run /trio setup again.`,
			"info",
		);
		return selectedConfig;
	}

	async function ensureConfigured(ctx: ExtensionContext): Promise<TrioConfig | undefined> {
		const loaded = loadConfig(ctx);
		config = loaded.config;
		configPaths = loaded.paths;
		if (config) return config;
		return runOnboarding(ctx);
	}

	function persistState(): void {
		if (state) pi.appendEntry(TRIO_STATE_ENTRY, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state?.active) {
			ctx.ui.setStatus("trio", undefined);
			return;
		}
		ctx.ui.setStatus("trio", ctx.ui.theme.fg("accent", `trio:${phaseLabel(state.phase)}`));
	}

	function requirePhase(expected: TrioPhase): TrioWorkflowState {
		if (!state?.active || state.phase !== expected) {
			throw new Error(`Trio tool is only valid during the ${expected} phase`);
		}
		return state;
	}

	function resolveRole(ctx: ExtensionContext, role: TrioRoleConfig) {
		const model = ctx.modelRegistry.find(role.provider, role.model);
		if (!model) throw new Error(`Configured Trio model not found: ${role.provider}/${role.model}`);
		return model;
	}

	async function selectRole(ctx: ExtensionContext, role: TrioRoleConfig): Promise<void> {
		const model = resolveRole(ctx, role);
		const usage = ctx.getContextUsage();
		if (usage && usage.tokens >= model.contextWindow * 0.95) {
			throw new Error(
				`Cannot switch to ${role.provider}/${role.model}: current context uses ${usage.tokens} tokens, near its ${model.contextWindow}-token limit`,
			);
		}

		if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
			const selected = await pi.setModel(model);
			if (!selected) throw new Error(`No credentials available for ${role.provider}/${role.model}`);
		}
		if (role.thinkingLevel !== undefined) pi.setThinkingLevel(role.thinkingLevel);
	}

	function activateToolsForPhase(phase: TrioPhase): void {
		if (!state) return;
		const available = pi.getAllTools().map((tool) => tool.name);
		pi.setActiveTools(getToolsForPhase(phase, state.original.tools, available));
	}

	async function enterPhase(phase: Exclude<TrioPhase, "idle">, ctx: ExtensionContext): Promise<void> {
		if (!state) throw new Error("Trio workflow state is unavailable");
		const currentConfig = requireConfig();
		let role = currentConfig.planner;
		if (phase === "executing") role = currentConfig.executor;
		if (phase === "reviewing") role = currentConfig.reviewer;
		await selectRole(ctx, role);
		state = { ...state, active: true, phase };
		activateToolsForPhase(phase);
		persistState();
		updateStatus(ctx);
	}

	async function restoreOriginalState(ctx: ExtensionContext, message?: string): Promise<void> {
		if (!state) return;
		announcedPhaseKey = undefined;
		const original = state.original;
		state = { ...state, active: false, phase: "idle" };

		const available = pi.getAllTools().map((tool) => tool.name);
		pi.setActiveTools(getToolsForPhase("idle", original.tools, available));

		if (original.model) {
			const model = ctx.modelRegistry.find(original.model.provider, original.model.model);
			if (!model) {
				ctx.ui.notify(
					`Could not restore model ${original.model.provider}/${original.model.model}: model not found`,
					"warning",
				);
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(
					`Could not restore model ${original.model.provider}/${original.model.model}: credentials unavailable`,
					"warning",
				);
			}
		}
		pi.setThinkingLevel(original.thinkingLevel);
		persistState();
		updateStatus(ctx);
		if (message) ctx.ui.notify(message, "info");
	}

	function ensureToolsRegistered(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;

		pi.registerTool({
			name: TRANSITION_TOOLS.delegate,
			label: "Delegate to Trio Executor",
			description:
				"Hand the approved implementation plan to the configured Trio executor model. Call this as the only tool in the response.",
			promptSnippet: "Switch from Trio planning to execution with a structured implementation plan.",
			promptGuidelines: [
				`Use ${TRANSITION_TOOLS.delegate} only after planning is complete, and call it as the only tool in the response.`,
			],
			parameters: Type.Object({
				task: Type.String({ description: "The concrete implementation task" }),
				plan: Type.Array(Type.String(), { minItems: 1, description: "Ordered implementation steps" }),
				acceptanceCriteria: Type.Array(Type.String(), {
					minItems: 1,
					description: "Observable conditions that must be satisfied",
				}),
				relevantFiles: Type.Optional(Type.Array(Type.String(), { description: "Likely relevant file paths" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				requirePhase("planning");
				await enterPhase("executing", ctx);
				return {
					content: [
						{
							type: "text",
							text: `Execution delegated. Implement the following plan, validate it, then call ${TRANSITION_TOOLS.submit}.\n\nTask: ${params.task}\n\nPlan:\n${params.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\nAcceptance criteria:\n${params.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}${params.relevantFiles?.length ? `\n\nRelevant files:\n${params.relevantFiles.map((file) => `- ${file}`).join("\n")}` : ""}`,
						},
					],
					details: { phase: "executing", plan: params.plan },
				};
			},
		});

		pi.registerTool({
			name: TRANSITION_TOOLS.submit,
			label: "Submit Trio Work for Review",
			description:
				"Return completed executor work to the configured Trio reviewer model. Call this as the only tool in the response.",
			promptSnippet: "Switch from Trio execution to review with implementation and test evidence.",
			promptGuidelines: [
				`Use ${TRANSITION_TOOLS.submit} after implementation and validation, and call it as the only tool in the response.`,
			],
			parameters: Type.Object({
				summary: Type.String({ description: "Factual summary of changes made" }),
				testsRun: Type.Array(Type.String(), { description: "Tests or checks run, including outcomes" }),
				unresolvedIssues: Type.Optional(Type.Array(Type.String(), { description: "Known blockers or remaining risks" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				requirePhase("executing");
				await enterPhase("reviewing", ctx);
				return {
					content: [
						{
							type: "text",
							text: `Executor submitted work for review.\n\nSummary:\n${params.summary}\n\nValidation:\n${params.testsRun.length ? params.testsRun.map((test) => `- ${test}`).join("\n") : "- None reported"}${params.unresolvedIssues?.length ? `\n\nUnresolved issues:\n${params.unresolvedIssues.map((issue) => `- ${issue}`).join("\n")}` : ""}`,
						},
					],
					details: { phase: "reviewing", reviewRound: state?.reviewRound ?? 0 },
				};
			},
		});

		pi.registerTool({
			name: TRANSITION_TOOLS.revise,
			label: "Request Trio Changes",
			description:
				"Send concrete review findings back to the Trio executor for another implementation pass. Call this as the only tool in the response.",
			promptSnippet: "Switch from Trio review back to execution with required corrections.",
			promptGuidelines: [
				`Use ${TRANSITION_TOOLS.revise} only for verified review findings, and call it as the only tool in the response.`,
			],
			parameters: Type.Object({
				issues: Type.Array(Type.String(), { minItems: 1, description: "Specific review findings" }),
				requiredChanges: Type.Array(Type.String(), { minItems: 1, description: "Concrete corrections required" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const current = requirePhase("reviewing");
				const currentConfig = requireConfig();
				if (
					currentConfig.maxReviewRounds !== undefined &&
					current.reviewRound >= currentConfig.maxReviewRounds
				) {
					throw new Error(
						`Maximum review rounds (${currentConfig.maxReviewRounds}) reached. Call ${TRANSITION_TOOLS.approve} and report remaining concerns.`,
					);
				}
				state = { ...current, reviewRound: current.reviewRound + 1 };
				await enterPhase("executing", ctx);
				return {
					content: [
						{
							type: "text",
							text: `Review requested another implementation pass. Address every required change, re-run validation, then call ${TRANSITION_TOOLS.submit}.\n\nIssues:\n${params.issues.map((issue) => `- ${issue}`).join("\n")}\n\nRequired changes:\n${params.requiredChanges.map((change) => `- ${change}`).join("\n")}`,
						},
					],
					details: { phase: "executing", reviewRound: state?.reviewRound ?? 0 },
				};
			},
		});

		pi.registerTool({
			name: TRANSITION_TOOLS.approve,
			label: "Approve Trio Work",
			description:
				"Approve the reviewed implementation and move to the planner's final user-facing response. Call this as the only tool in the response.",
			promptSnippet: "Approve Trio implementation and prepare the final response.",
			promptGuidelines: [
				`Use ${TRANSITION_TOOLS.approve} only after reviewing the actual changes, and call it as the only tool in the response.`,
			],
			parameters: Type.Object({
				summary: Type.String({ description: "Review conclusion" }),
				remainingConcerns: Type.Optional(Type.Array(Type.String(), { description: "Caveats to disclose to the user" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				requirePhase("reviewing");
				await enterPhase("finalizing", ctx);
				return {
					content: [
						{
							type: "text",
							text: `Review approved. Now provide the final response to the user.\n\nReview conclusion:\n${params.summary}${params.remainingConcerns?.length ? `\n\nRemaining concerns:\n${params.remainingConcerns.map((concern) => `- ${concern}`).join("\n")}` : ""}`,
						},
					],
					details: { phase: "finalizing", reviewRound: state?.reviewRound ?? 0 },
				};
			},
		});
	}

	async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (state?.active) {
			ctx.ui.notify(`Trio is already active in the ${state.phase} phase. Use /trio stop first.`, "warning");
			return;
		}

		const currentConfig = await ensureConfigured(ctx);
		if (!currentConfig) return;
		announcedPhaseKey = undefined;
		resolveRole(ctx, currentConfig.planner);
		resolveRole(ctx, currentConfig.executor);
		resolveRole(ctx, currentConfig.reviewer);

		const original: OriginalSessionState = {
			model: ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};
		ensureToolsRegistered();
		state = {
			version: 1,
			active: true,
			phase: "planning",
			task,
			reviewRound: 0,
			original,
		};

		try {
			await enterPhase("planning", ctx);
		} catch (error) {
			state = undefined;
			pi.setActiveTools(original.tools);
			throw error;
		}

		pi.sendUserMessage(`[TRIO WORKFLOW REQUEST]\n${task}`);
		await ctx.waitForIdle();
	}

	pi.registerCommand("trio", {
		description: "Run an explicit planner → executor → reviewer workflow",
		getArgumentCompletions(prefix) {
			const items = ["status", "config", "setup", "stop", "start "].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /trio <task> | /trio status | /trio config | /trio setup | /trio stop", "info");
				return;
			}

			if (input === "status") {
				if (!state?.active) {
					ctx.ui.notify("Trio is idle. Transition tools are not active.", "info");
					return;
				}
				const maxReviewRounds = requireConfig().maxReviewRounds;
				const reviewRounds =
					maxReviewRounds === undefined ? `${state.reviewRound}` : `${state.reviewRound}/${maxReviewRounds}`;
				ctx.ui.notify(`Trio phase: ${state.phase}; review rounds used: ${reviewRounds}`, "info");
				return;
			}

			if (input === "config") {
				const loaded = loadConfig(ctx);
				config = loaded.config;
				configPaths = loaded.paths;
				if (!config) {
					ctx.ui.notify(
						`Trio is not configured. Run /trio setup. Config will be saved to ${join(getAgentDir(), CONFIG_FILE_NAME)}.`,
						"info",
					);
					return;
				}
				ctx.ui.notify(`Trio config (${configPaths.join(", ")}):\n${JSON.stringify(config, null, 2)}`, "info");
				return;
			}

			if (input === "setup") {
				if (state?.active) {
					ctx.ui.notify("Stop the active Trio workflow before changing its models.", "warning");
					return;
				}
				try {
					await runOnboarding(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			if (input === "stop") {
				if (!state?.active) {
					ctx.ui.notify("Trio is already idle.", "info");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.abort();
					await ctx.waitForIdle();
				}
				await restoreOriginalState(ctx, "Trio stopped; previous model and tools restored.");
				return;
			}

			const task = input.startsWith("start ") ? input.slice("start ".length).trim() : input;
			if (!task) {
				ctx.ui.notify("Usage: /trio start <task>", "error");
				return;
			}

			try {
				await ctx.waitForIdle();
				await startWorkflow(task, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!TRANSITION_TOOL_NAMES.has(event.toolName)) return;
		const count = getToolCallCount(ctx, event.toolCallId);
		if (count !== undefined && count > 1) {
			return {
				block: true,
				reason: `${event.toolName} must be the only tool call in its response. Finish the other calls, then retry the transition alone.`,
			};
		}
	});

	pi.on("context", (event) => {
		if (!state?.active || !config) return;
		const phaseKey = `${state.phase}:${state.reviewRound}`;
		if (phaseKey === announcedPhaseKey) return;
		const instructions = getPhaseInstructions(state, config);
		if (!instructions) return;
		announcedPhaseKey = phaseKey;
		const phaseMessage: AgentMessage = {
			role: "custom",
			customType: "trio-phase",
			content: instructions,
			display: false,
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, phaseMessage] };
	});

	pi.on("session_compact", () => {
		// Compaction can summarize away the one-time phase framing; re-announce it once.
		announcedPhaseKey = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (state?.active && state.phase === "finalizing") {
			await restoreOriginalState(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const loaded = loadConfig(ctx);
			config = loaded.config;
			configPaths = loaded.paths;
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			config = undefined;
			configPaths = [];
		}

		state = readLatestWorkflowState(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (state?.active) {
			try {
				ensureToolsRegistered();
				await enterPhase(state.phase === "idle" ? "planning" : state.phase, ctx);
			} catch (error) {
				ctx.ui.notify(`Could not restore Trio workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
		updateStatus(ctx);
	});
}
