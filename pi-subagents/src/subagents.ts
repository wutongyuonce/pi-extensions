import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { AgentListEntry } from "./agents/agent-list.ts";
import {
	getAgentListEntries as getAgentListEntriesFromDefinitions,
	getAgentListSignature,
	renderAgentListReminder,
} from "./agents/agent-list.ts";
import type { AgentDefaults } from "./agents/definitions.ts";
import {
	getEffectiveAgentDefinitions,
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
} from "./agents/definitions.ts";
import {
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	resolveSubagentNoSession,
} from "./launch/policy.ts";
import { resolveSubagentCwd } from "./launch/runtime-paths.ts";
import { getNoSessionSeedMode } from "./launch/seed-child-session.ts";
import { initializeSpawnWidthForSession } from "./runtime/spawn-width.ts";
import { publishRunningSubagentCount } from "./runtime/nested-lifecycle.ts";
import { parseSpawnEnv } from "./spawn/policy.ts";

export { resolveSubagentConfigDir } from "./launch/runtime-paths.ts";
export { buildSkillLaunchPlan as buildSkillLaunchPlanForTest } from "./launch/skills.ts";

import { isMuxAvailable, muxSetupHint } from "./mux.ts";
import {
	formatElapsed,
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	launchBackgroundSubagent,
	launchSubagent,
	moduleAbortController,
	runningSubagents,
	shutdownSubagentsForParentExit,
	startWidgetRefresh,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	widgetManager,
	wireSubagentSteerBack,
} from "./runtime/wiring.ts";
import {
	resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
	resolveTaskSessionMode as resolveTaskSessionModeFromSessionFiles,
	type SubagentSessionMode,
} from "./session/session-files.ts";
import type { SubagentParamsInput } from "./types.ts";

export {
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getPiInvocationForTest,
	getShellReadyDelayMs,
	getStartedSubagentDetailsForTest,
	getSubagentChildProcessEnvForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	waitForSubagentForTest,
} from "./runtime/wiring.ts";

import { traceSubagentLaunch } from "./launch/trace.ts";
import { classifyAssistantMessageForMixedBatch } from "./runtime/batch-classifier.ts";
import {
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
	stopAfterCurrentSubagentBatch,
} from "./runtime/state.ts";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.ts";
import { registerSubagentResumeTool } from "./tools/resume-tool.ts";
import {
	isHeadlessLaunchSession,
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
} from "./tools/subagent-tools.ts";
import { registerSubagentsView } from "./tools/subagents-view.ts";
import { SUBAGENT_TOOL_NAME } from "./tools/tool-names.ts";
import { adoptVerifiedRuns } from "./vf/run/adopt.ts";
import { createOrchestratorController } from "./runtime/orchestrator-controller.ts";

export { classifyAssistantMessageForMixedBatch as classifyAssistantMessageForMixedBatchForTest } from "./runtime/batch-classifier.ts";
export { shouldAwaitSubagentLaunch as shouldAwaitSubagentLaunchForTest } from "./runtime/running-registry.ts";
export {
	getSubagentBatchStopMetadata as getSubagentBatchStopMetadataForTest,
	markSubagentBatchBlocking as markSubagentBatchBlockingForTest,
	requestSubagentBatchStop as requestSubagentBatchStopForTest,
} from "./runtime/state.ts";
export * from "./testing/test-helpers.ts";

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(agentName, cwdHint, baseCwd, resolveSubagentCwd);
}

function getAgentListEntries(baseCwd = process.cwd()): AgentListEntry[] {
	const callerEnv = parseSpawnEnv(process.env);
	return getAgentListEntriesFromDefinitions(baseCwd, resolveTaskSessionMode, {
		callerAgent: callerEnv.callerAgent,
		callerSpawnable: callerEnv.callerSpawnable,
	});
}

function resolveEffectiveSessionMode(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}

function resolveTaskSessionMode(agentDefs: AgentDefaults | null): SubagentSessionMode {
	return resolveTaskSessionModeFromSessionFiles(agentDefs, resolveSubagentNoSession, getNoSessionSeedMode);
}

let lastAmbientRosterSignature: string | null = null;
let pendingAmbientRoster: {
	signature: string;
	content: string;
	entries: AgentListEntry[];
	supersedes?: true;
} | null = null;

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	const text =
		kind === "tab-title"
			? `Terminal multiplexer not available. ${muxSetupHint()}`
			: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { error: "mux not available" },
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	// Register nothing when the user has no named agents. The factory re-runs
	// on every session replacement (/new, /resume, /fork) and on /reload, so
	// creating an agent file and starting a session restores the full surface.
	if (getEffectiveAgentDefinitions().length === 0) return;

	publishRunningSubagentCount(() => runningSubagents.size);

	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	function applySubagentLineage(ctx: ExtensionContext) {
		const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
		if (!parentSession) return;
		const header = ctx.sessionManager.getHeader?.();
		if (!header || header.parentSession) return;
		header.parentSession = parentSession;
	}

	const orchestrator = createOrchestratorController(pi, {
		environment: process.env,
		getRunningSubagentCount: () => runningSubagents.size,
	});
	let latestContext: ExtensionContext | undefined;

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (event, ctx) => {
		initializeSpawnWidthForSession();
		latestContext = ctx;
		resetSubagentBatchStopRequest();
		applySubagentLineage(ctx);
		attachWidgetContext(ctx);
		orchestrator.handleSessionStart(ctx);
		// Verified fan-outs outlive their parent session: deliver finished
		// results exactly once to their authorized recipient and re-watch live
		// runs (detached supervisors keep candidates running across
		// quit/reload/replacement).
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
		adoptVerifiedRuns(pi, ctx.cwd, {
			sessionId: ctx.sessionManager.getSessionId?.() ?? "",
			// In print mode a startup steer must not trigger a model turn: the
			// `-p` process has its own single prompt to run, and triggering a
			// second turn at session start crashes some extensions' stale
			// captured contexts.
			triggerTurn: ctx.mode !== "print",
			confirmPersisted: sessionFile
				? async (deliveryId) => {
						// The send is async in Pi; poll our own transcript until the
						// deliveryId entry lands, then the receipt may be written.
						const deadline = Date.now() + 5_000;
						while (Date.now() < deadline) {
							try {
								if (readFileSync(sessionFile, "utf8").includes(deliveryId)) return true;
							} catch {
								// not flushed yet
							}
							await new Promise((resolve) => setTimeout(resolve, 150));
						}
						return false;
					}
				: undefined,
			updateWidget: () => widgetManager.update(),
		}).catch(() => {
			// Adoption is best-effort at startup; a failure must never block
			// the session from starting.
		});

		if (!shouldRegister(SUBAGENT_TOOL_NAME)) return;

		// Reset the cached signature on every fresh session so module-level state
		// does not leak between sessions. The reload path still uses the cached
		// signature to avoid duplicating the notification within the same session.
		if (event.reason !== "reload") {
			lastAmbientRosterSignature = null;
		}

		const entries = getAgentListEntries(ctx.cwd);
		const signature = getAgentListSignature(entries);
		// A headless parent awaits every launch, so the roster must not promise
		// a later report the model would otherwise plan around.
		const rosterOptions = { awaitAllLaunches: isHeadlessLaunchSession(ctx.hasUI) };
		if (entries.length === 0) {
			const hasDescribedAgents = getEffectiveAgentDefinitions(ctx.cwd).some((agent) => agent.description?.trim());
			if (!hasDescribedAgents && lastAmbientRosterSignature === null) {
				pendingAmbientRoster = null;
				return;
			}
			if (signature === lastAmbientRosterSignature) {
				pendingAmbientRoster = null;
				return;
			}
			pendingAmbientRoster = {
				signature,
				content: renderAgentListReminder(entries, rosterOptions),
				entries,
				supersedes: true,
			};
			return;
		}

		if (signature === lastAmbientRosterSignature) {
			pendingAmbientRoster = null;
			return;
		}

		pendingAmbientRoster = {
			signature,
			content: renderAgentListReminder(entries, rosterOptions),
			entries,
			supersedes: event.reason === "reload" ? true : undefined,
		};
	});

	pi.on("before_agent_start", (event) => {
		const rosterResult = pendingAmbientRoster
			? {
					message: {
						customType: "subagent_roster",
						content: pendingAmbientRoster.content,
						display: false,
						details: {
							entries: pendingAmbientRoster.entries,
							signature: pendingAmbientRoster.signature,
							...(pendingAmbientRoster.supersedes ? { supersedes: true } : {}),
						},
					},
				}
			: undefined;
		if (pendingAmbientRoster) {
			lastAmbientRosterSignature = pendingAmbientRoster.signature;
			pendingAmbientRoster = null;
		}

		const orchestratorResult = orchestrator.beforeAgentStart(event);
		if (!rosterResult && !orchestratorResult) return undefined;
		return {
			...(rosterResult ?? {}),
			...(orchestratorResult ?? {}),
		};
	});

	pi.on("input", () => {
		resetSubagentBatchStopRequest();
		return { action: "continue" as const };
	});

	pi.on("message_end", (event) => {
		// Mixed-batch barrier: when an assistant message contains BOTH an async
		// subagent launch (subagent or subagent_resume) AND a non-subagent tool,
		// mark the batch blocking before any tool runs. The shared
		// shouldAwaitSubagentLaunch predicate then routes both subagent and
		// subagent_resume launches through the await path so the parent's
		// next turn sees completed results instead of racing the children.
		// Gated by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN to share a kill
		// switch with the existing coordinator-only-turn behavior.
		const message = event?.message;
		if (!message) return;
		classifyAssistantMessageForMixedBatch(message, (agent, cwd) => (agent ? loadAgentDefaults(agent, cwd) : null));
	});

	pi.on("tool_call", (event) => {
		const orchestratorResult = orchestrator.handleToolCall(event);
		if (orchestratorResult) return orchestratorResult;
		if (event.toolName !== SUBAGENT_TOOL_NAME) return {};
		const input = event.input as Partial<SubagentParamsInput>;
		const agentDefs =
			typeof input.agent === "string"
				? loadAgentDefaults(input.agent, typeof input.cwd === "string" ? input.cwd : undefined)
				: null;
		const agentError = getSubagentAgentRequirementError(input, agentDefs);
		const agentOverrideError = getSubagentAgentOverrideError(input, agentDefs);
		if (!agentError && !agentOverrideError) {
			if (resolveSubagentBlocking(input, agentDefs)) {
				markSubagentBatchBlocking();
			} else {
				requestSubagentBatchStop();
			}
		}
		return {};
	});

	pi.on("session_tree", (_event, ctx) => {
		orchestrator.handleSessionTree(ctx);
	});

	pi.on("turn_start", () => {
		resetSubagentBatchStopRequest();
	});

	pi.on("agent_end", () => {
		resetSubagentBatchStopRequest();
		markInitialPromptLaunchComplete();
	});

	// Clean up on real session shutdown. Pi also emits this event for the
	// coordinator-only turn stop after async launches; that must not kill the
	// children that the stop was created to leave running.
	pi.on("session_shutdown", async (event, ctx) => {
		traceSubagentLaunch("session.shutdown", {
			coordinatorOnlyTurnStop: stopAfterCurrentSubagentBatch,
			eventKeys: Object.keys((event ?? {}) as unknown as Record<string, unknown>),
			running: runningSubagents.size,
		});
		if (stopAfterCurrentSubagentBatch) {
			resetSubagentBatchStopRequest();
			return;
		}
		orchestrator.handleSessionShutdown(ctx);

		moduleAbortController.abort();
		widgetManager.reset();
		resetSubagentBatchStopRequest();
		await shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);

	registerSubagentCoreTools(pi, shouldRegister, {
		loadAgentDefaults: (agentName, cwd) => (agentName ? loadAgentDefaults(agentName, undefined, cwd) : null),
		resolveEffectiveSessionMode,
		resolveTaskSessionMode,
		launchBackgroundSubagent,
		launchSubagent,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		stopRunningSubagent,
		muxUnavailableResult: () => muxUnavailableResult("tab-title"),
	});

	registerSubagentResumeTool(pi, shouldRegister, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		runningSubagents,
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
		modelRegistry: {
			getAvailable: () => latestContext?.modelRegistry.getAvailable() ?? [],
		},
	});

	registerSubagentMessageRenderers(pi, formatElapsed);

	registerSubagentsView(
		pi,
		{
			getShellReadyDelayMs,
			isMuxAvailable,
			watchBackgroundSubagent,
			watchSubagent,
			getWatcherSignal,
			startWidgetRefresh,
			getContextWindow: (modelRef: string) => widgetManager.resolveModelContextWindow(modelRef),
			runningSubagents,
			pi,
			wireSubagentSteerBack,
			orchestrator,
		},
	);
}
