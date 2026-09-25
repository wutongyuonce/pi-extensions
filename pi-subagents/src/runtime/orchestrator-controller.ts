import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	buildOrchestratorSessionState,
	ORCHESTRATOR_SESSION_CUSTOM_TYPE,
	readOrchestratorSessionState,
} from "../session/orchestrator-state.ts";
import {
	loadOrchestratorGlobalConfig,
	type OrchestratorEffectiveDefault,
	type OrchestratorGlobalConfig,
	resolveOrchestratorEffectiveDefault,
	saveOrchestratorGlobalDefault,
} from "./orchestrator-config.ts";
import {
	chooseOrchestratorBaseline,
	currentToolsAreControllerRestricted,
	deriveNormalToolsOnDisable,
	filterOrchestratorTools,
	isSubagentChildEnvironment,
	normalizeOrchestratorTools,
	sameOrchestratorTools,
} from "./orchestrator-policy.ts";
import { ORCHESTRATOR_BASE_PROMPT } from "./orchestrator-prompt.ts";
import { runningSubagents } from "./state.ts";

type OrchestratorBlockedReason =
	| "child-session"
	| "running-subagents"
	| "parent-busy"
	| "pending-messages"
	| "context-unavailable";

type OrchestratorSavedDefaultSource = OrchestratorGlobalConfig["source"];
type OrchestratorEffectiveDefaultSource =
	OrchestratorEffectiveDefault["source"];

/** Runtime context required for orchestrator guards and session persistence. */
export interface OrchestratorContext {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	ui: Pick<ExtensionContext["ui"], "notify">;
}

/** Minimal Pi API used to read and change the active tool set. */
export type OrchestratorRuntimeAPI = Pick<
	ExtensionAPI,
	"appendEntry" | "getActiveTools" | "setActiveTools"
>;

/** Current mode, tool, guard, and persistence state exposed to the UI. */
export interface OrchestratorSnapshot {
	currentMode: boolean;
	savedGlobalDefault: boolean;
	savedGlobalDefaultSource: OrchestratorSavedDefaultSource;
	effectiveGlobalDefault: boolean;
	effectiveGlobalDefaultSource: OrchestratorEffectiveDefaultSource;
	currentActiveTools: string[];
	normalActiveTools: string[];
	runningSubagents: number;
	parentIdle: boolean | undefined;
	hasPendingMessages: boolean | undefined;
	blockedReason: OrchestratorBlockedReason | null;
	isChildSession: boolean;
	globalConfigError?: string;
	persistenceError?: string;
}

interface OrchestratorOperationResult {
	ok: boolean;
	changed: boolean;
	snapshot: OrchestratorSnapshot;
	reason?: OrchestratorBlockedReason | "persistence-error";
	error?: string;
}

/** Dependencies and environment overrides used to construct a controller. */
export interface OrchestratorControllerOptions {
	agentDir?: string;
	environment?: Readonly<Record<string, string | undefined>>;
	getRunningSubagentCount?: () => number;
}

const CONFIGURATION_ISSUE_PREFIX = "[pi-subagents] ";

function isNonEmpty(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Lifecycle controller for orchestrator mode and its persisted tool baseline. */
export interface OrchestratorController {
	getSnapshot(ctx?: OrchestratorContext): OrchestratorSnapshot;
	setMode(
		enabled: boolean,
		ctx?: OrchestratorContext,
	): OrchestratorOperationResult;
	saveGlobalDefault(
		enabled: boolean,
		ctx?: OrchestratorContext,
	): OrchestratorOperationResult;
	handleSessionStart(ctx: OrchestratorContext): void;
	handleSessionTree(ctx: OrchestratorContext): void;
	handleSessionShutdown(ctx: OrchestratorContext): void;
	beforeAgentStart(
		event: Pick<BeforeAgentStartEvent, "systemPromptOptions">,
	): { systemPrompt: string } | undefined;
	handleToolCall(
		event: Pick<ToolCallEvent, "toolName">,
	): ToolCallEventResult | undefined;
}

/** Create a controller bound to one Pi runtime and session lifecycle. */
export function createOrchestratorController(
	api: OrchestratorRuntimeAPI,
	options: OrchestratorControllerOptions = {},
): OrchestratorController {
	const environment = { ...(options.environment ?? process.env) };
	const agentDir = options.agentDir ?? getAgentDir();
	const childSession = isSubagentChildEnvironment(environment);
	const getRunningSubagentCount =
		options.getRunningSubagentCount ?? (() => runningSubagents.size);
	let globalConfig: OrchestratorGlobalConfig = {
		path: agentDir,
		savedDefault: false,
		source: "missing",
	};
	let effectiveDefault: OrchestratorEffectiveDefault = {
		value: false,
		source: "missing",
	};
	let currentMode = false;
	let normalActiveTools: string[] = [];
	let modeActiveTools: string[] = [];
	let context: OrchestratorContext | undefined;
	let initialized = false;
	let baselineDirty = false;
	let persistenceError: string | undefined;
	let lastNotifiedIssue: string | undefined;

	function refreshGlobalDefaults(): void {
		if (childSession) return;
		globalConfig = loadOrchestratorGlobalConfig(agentDir);
		effectiveDefault = resolveOrchestratorEffectiveDefault(
			environment,
			agentDir,
		);
	}

	function notify(
		ctx: OrchestratorContext | undefined,
		message: string,
		type: "info" | "warning" | "error",
	): void {
		ctx?.ui.notify?.(message, type);
	}

	function notifyConfigurationIssue(
		ctx: OrchestratorContext | undefined,
	): void {
		const issue = effectiveDefault.error ?? globalConfig.error;
		if (!issue || issue === lastNotifiedIssue) return;
		lastNotifiedIssue = issue;
		notify(ctx, CONFIGURATION_ISSUE_PREFIX + issue, "error");
	}

	function getCurrentTools(): string[] {
		try {
			return normalizeOrchestratorTools(api.getActiveTools());
		} catch {
			return [];
		}
	}

	function setCurrentTools(toolNames: readonly string[]): void {
		api.setActiveTools(normalizeOrchestratorTools(toolNames));
	}

	function persistSessionState(
		ctx: OrchestratorContext,
		enabled: boolean,
		activeTools: readonly string[],
		shouldNotify = true,
	): boolean {
		try {
			api.appendEntry(
				ORCHESTRATOR_SESSION_CUSTOM_TYPE,
				buildOrchestratorSessionState(enabled, activeTools),
			);
			persistenceError = undefined;
			return true;
		} catch (error) {
			persistenceError = error instanceof Error ? error.message : String(error);
			if (shouldNotify) {
				notify(
					ctx,
					CONFIGURATION_ISSUE_PREFIX +
						"Could not persist orchestrator session state: " +
						persistenceError,
					"error",
				);
			}
			return false;
		}
	}

	function getGuardState(ctx: OrchestratorContext | undefined): {
		parentIdle: boolean | undefined;
		hasPendingMessages: boolean | undefined;
		blockedReason: OrchestratorBlockedReason | null;
	} {
		if (childSession)
			return {
				parentIdle: undefined,
				hasPendingMessages: undefined,
				blockedReason: "child-session",
			};
		if (!ctx)
			return {
				parentIdle: undefined,
				hasPendingMessages: undefined,
				blockedReason: "context-unavailable",
			};

		let parentIdle = false;
		let hasPendingMessages = true;
		try {
			parentIdle = ctx.isIdle();
		} catch {
			parentIdle = false;
		}
		try {
			hasPendingMessages = ctx.hasPendingMessages();
		} catch {
			hasPendingMessages = true;
		}
		const running = getRunningSubagentCount();
		if (running > 0)
			return {
				parentIdle,
				hasPendingMessages,
				blockedReason: "running-subagents",
			};
		if (!parentIdle)
			return { parentIdle, hasPendingMessages, blockedReason: "parent-busy" };
		if (hasPendingMessages)
			return {
				parentIdle,
				hasPendingMessages,
				blockedReason: "pending-messages",
			};
		return { parentIdle, hasPendingMessages, blockedReason: null };
	}

	function getSnapshot(ctx?: OrchestratorContext): OrchestratorSnapshot {
		if (ctx) context = ctx;
		const guard = getGuardState(ctx ?? context);
		return {
			currentMode,
			savedGlobalDefault: childSession ? false : globalConfig.savedDefault,
			savedGlobalDefaultSource: childSession ? "missing" : globalConfig.source,
			effectiveGlobalDefault: childSession ? false : effectiveDefault.value,
			effectiveGlobalDefaultSource: childSession
				? "missing"
				: effectiveDefault.source,
			currentActiveTools: getCurrentTools(),
			normalActiveTools: [...normalActiveTools],
			runningSubagents: getRunningSubagentCount(),
			parentIdle: guard.parentIdle,
			hasPendingMessages: guard.hasPendingMessages,
			blockedReason: guard.blockedReason,
			isChildSession: childSession,
			...((globalConfig.error ?? effectiveDefault.error)
				? { globalConfigError: globalConfig.error ?? effectiveDefault.error }
				: {}),
			...(persistenceError ? { persistenceError } : {}),
		};
	}

	function readBranchState(ctx: OrchestratorContext) {
		try {
			return readOrchestratorSessionState(ctx.sessionManager.getBranch());
		} catch {
			return undefined;
		}
	}

	function applyBranchState(
		ctx: OrchestratorContext,
		persistMissing: boolean,
	): void {
		const previousMode = currentMode;
		const currentTools = getCurrentTools();
		const persisted = readBranchState(ctx);
		const baseline = chooseOrchestratorBaseline(
			persisted?.activeTools,
			previousMode,
			currentTools,
			normalActiveTools,
			!initialized,
		);
		const enabled = persisted?.enabled ?? effectiveDefault.value;
		const shouldPersist =
			persistMissing &&
			(!persisted?.activeTools ||
				!sameOrchestratorTools(persisted.activeTools, baseline) ||
				persisted.enabled !== enabled);

		if (shouldPersist && !persistSessionState(ctx, enabled, baseline)) {
			// Keep the live runtime in its previous state when session persistence is
			// unavailable. A mode that cannot be represented in the branch is unsafe.
			normalActiveTools = currentMode
				? [...normalActiveTools]
				: [...currentTools];
			return;
		}

		normalActiveTools = baseline;
		currentMode = enabled;
		const desiredTools = enabled
			? currentToolsAreControllerRestricted(previousMode, currentTools)
				? filterOrchestratorTools(baseline)
				: filterOrchestratorTools(currentTools)
			: baseline;
		setCurrentTools(desiredTools);
		modeActiveTools = enabled ? [...desiredTools] : [];
		baselineDirty = false;
	}

	function restorePreviousState(
		previousMode: boolean,
		previousNormalTools: readonly string[],
		previousActiveTools: readonly string[],
	): void {
		currentMode = previousMode;
		normalActiveTools = [...previousNormalTools];
		modeActiveTools = previousMode
			? [...filterOrchestratorTools(previousActiveTools)]
			: [];
		try {
			setCurrentTools(previousActiveTools);
		} catch {
			// The runtime may already be tearing down; preserve the operation error.
		}
	}

	refreshGlobalDefaults();

	const controller: OrchestratorController = {
		getSnapshot,
		setMode(enabled, nextContext) {
			if (nextContext) context = nextContext;
			const before = getSnapshot(nextContext);
			if (before.blockedReason) {
				return {
					ok: false,
					changed: false,
					snapshot: before,
					reason: before.blockedReason,
				};
			}
			if (!initialized || !context) {
				return {
					ok: false,
					changed: false,
					snapshot: before,
					reason: "context-unavailable",
				};
			}
			if (enabled === currentMode)
				return { ok: true, changed: false, snapshot: before };

			const previousMode = currentMode;
			const previousActiveTools = getCurrentTools();
			const previousNormalTools = [...normalActiveTools];
			const nextNormalTools = enabled
				? [...previousActiveTools]
				: deriveNormalToolsOnDisable(
						previousActiveTools,
						normalActiveTools,
						modeActiveTools,
					);
			const operationContext = nextContext ?? context;
			if (!persistSessionState(operationContext, enabled, nextNormalTools)) {
				return {
					ok: false,
					changed: false,
					snapshot: getSnapshot(nextContext),
					reason: "persistence-error",
					error: persistenceError,
				};
			}

			try {
				const desiredTools = enabled
					? filterOrchestratorTools(previousActiveTools)
					: nextNormalTools;
				setCurrentTools(desiredTools);
				currentMode = enabled;
				normalActiveTools = nextNormalTools;
				modeActiveTools = enabled ? [...desiredTools] : [];
				baselineDirty = false;
				return { ok: true, changed: true, snapshot: getSnapshot(nextContext) };
			} catch (error) {
				restorePreviousState(
					previousMode,
					previousNormalTools,
					previousActiveTools,
				);
				persistSessionState(
					operationContext,
					previousMode,
					previousNormalTools,
					false,
				);
				const message = error instanceof Error ? error.message : String(error);
				persistenceError = message;
				return {
					ok: false,
					changed: false,
					snapshot: getSnapshot(nextContext),
					reason: "persistence-error",
					error: message,
				};
			}
		},
		saveGlobalDefault(enabled, nextContext) {
			if (nextContext) context = nextContext;
			if (childSession) {
				const snapshot = getSnapshot(nextContext);
				return { ok: false, changed: false, snapshot, reason: "child-session" };
			}

			const result = saveOrchestratorGlobalDefault(enabled, agentDir);
			if (!result.ok) {
				const error = result.error ?? "unknown write failure";
				persistenceError = error;
				notify(
					nextContext ?? context,
					CONFIGURATION_ISSUE_PREFIX + error,
					"error",
				);
				return {
					ok: false,
					changed: false,
					snapshot: getSnapshot(nextContext),
					reason: "persistence-error",
					error,
				};
			}
			refreshGlobalDefaults();
			persistenceError = undefined;
			return { ok: true, changed: true, snapshot: getSnapshot(nextContext) };
		},
		handleSessionStart(nextContext) {
			context = nextContext;
			if (childSession) {
				currentMode = false;
				normalActiveTools = [];
				modeActiveTools = [];
				initialized = true;
				return;
			}
			refreshGlobalDefaults();
			try {
				applyBranchState(nextContext, true);
			} catch (error) {
				persistenceError =
					error instanceof Error ? error.message : String(error);
				currentMode = false;
				normalActiveTools = getCurrentTools();
				modeActiveTools = [];
			}
			initialized = true;
			notifyConfigurationIssue(nextContext);
		},
		handleSessionTree(nextContext) {
			context = nextContext;
			if (childSession || !initialized) return;
			try {
				applyBranchState(nextContext, true);
			} catch (error) {
				persistenceError =
					error instanceof Error ? error.message : String(error);
			}
		},
		handleSessionShutdown(nextContext) {
			context = nextContext;
			if (childSession || !initialized) return;
			const currentTools = getCurrentTools();
			if (!currentMode) {
				if (!sameOrchestratorTools(normalActiveTools, currentTools)) {
					normalActiveTools = currentTools;
					baselineDirty = true;
				}
			}
			if (!baselineDirty) return;
			if (
				persistSessionState(nextContext, currentMode, normalActiveTools, false)
			)
				baselineDirty = false;
		},
		beforeAgentStart(event) {
			if (childSession || !currentMode) {
				if (!childSession && !currentMode) {
					const currentTools = getCurrentTools();
					if (!sameOrchestratorTools(normalActiveTools, currentTools)) {
						normalActiveTools = currentTools;
						baselineDirty = true;
					}
				}
				return undefined;
			}

			const currentTools = getCurrentTools();
			if (
				currentTools.some((name) => !filterOrchestratorTools([name]).length)
			) {
				normalActiveTools = [...currentTools];
				baselineDirty = true;
			}
			const allowedTools = filterOrchestratorTools(currentTools);
			if (!sameOrchestratorTools(currentTools, allowedTools))
				setCurrentTools(allowedTools);
			modeActiveTools = [...allowedTools];
			const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
			return {
				systemPrompt: isNonEmpty(appendPrompt)
					? `${ORCHESTRATOR_BASE_PROMPT}\n\n${appendPrompt}`
					: ORCHESTRATOR_BASE_PROMPT,
			};
		},
		handleToolCall(event) {
			if (
				childSession ||
				!currentMode ||
				filterOrchestratorTools([event.toolName]).length > 0
			)
				return undefined;
			return {
				block: true,
				reason:
					"Orchestrator mode only permits delegation and orchestrator-control tools.",
			};
		},
	};

	return controller;
}
