import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEffectiveAgentDefinitions } from "../agents/definitions.ts";
import { completedSubagentResults, runningSubagents } from "../runtime/state.ts";
import { appendOrchestratorSessionState } from "../session/orchestrator-state.ts";
import { type OverlayRuntime, SubagentsOverlayController, type SubagentsOverlayResult } from "./overlay/index.ts";
import { getOrchestratorGuardMessage } from "./overlay/orchestrator-view.ts";

export { SubagentsOverlayController as SubagentsOverlay } from "./overlay/index.ts";

export function registerSubagentsView(pi: ExtensionAPI, runtime: OverlayRuntime) {
	let activeOverlay: SubagentsOverlayController | null = null;
	let activeOverlayPromise: Promise<SubagentsOverlayResult> | null = null;

	async function open(ctx: ExtensionContext): Promise<SubagentsOverlayResult> {
		if (activeOverlay || activeOverlayPromise) return null;
		if (!runningSubagents.size && !completedSubagentResults.size && !getEffectiveAgentDefinitions().length && !runtime.orchestrator) {
			ctx.ui.notify("No subagents or definitions.", "info");
			return null;
		}

		let overlay: SubagentsOverlayController | null = null;
		const customPromise = ctx.ui.custom<SubagentsOverlayResult>((tui, theme, _keybindings, done) => {
			overlay = new SubagentsOverlayController(
				done,
				ctx,
				{
					fg: (tone, text) => theme.fg(tone as Parameters<typeof theme.fg>[0], text),
					bg: (color, text) => theme.bg(color as Parameters<typeof theme.bg>[0], text),
					bold: (text) => theme.bold(text),
				},
				runtime,
				tui,
			);
			activeOverlay = overlay;
			return overlay;
		});
		const trackedPromise = customPromise.finally(() => {
			if (activeOverlay === overlay) activeOverlay = null;
			if (activeOverlayPromise === trackedPromise) activeOverlayPromise = null;
		});
		activeOverlayPromise = trackedPromise;
		return trackedPromise;
	}

	async function startFreshSession(ctx: ExtensionCommandContext, targetMode: boolean): Promise<void> {
		const controller = runtime.orchestrator;
		if (!controller) {
			ctx.ui.notify("Orchestrator controls are unavailable in this session.", "error");
			return;
		}

		try {
			const parentSession = ctx.sessionManager.getSessionFile();
			const snapshot = controller.getSnapshot(ctx);
			if (snapshot.blockedReason) {
				ctx.ui.notify(getOrchestratorGuardMessage(snapshot) ?? "Wait for the current work to finish or stop it explicitly.", "warning");
				return;
			}

			const result = await ctx.newSession({
				...(parentSession ? { parentSession } : {}),
				setup: async (sessionManager) => {
					appendOrchestratorSessionState(sessionManager, targetMode);
				},
			});
			if (result.cancelled) return;
		} catch (error) {
			ctx.ui.notify(
				"Could not start a fresh " +
					(targetMode ? "orchestrator" : "normal") +
					" session: " +
					(error instanceof Error ? error.message : String(error)),
				"error",
			);
		}
	}

	pi.registerCommand("subagents", {
		description: "Open subagent manager",
		handler: async (_args, ctx) => {
			const result = await open(ctx);
			if (result?.kind === "fresh-session") await startFreshSession(ctx, result.targetMode);
		},
	});

	pi.registerShortcut?.("alt+s", {
		description: "Toggle subagent manager",
		handler: async (_ctx) => {
			if (activeOverlay) {
				activeOverlay.close();
				return;
			}
			pi.sendUserMessage("/subagents", { expandPromptTemplates: true });
		},
	});

	pi.on("session_shutdown", async () => {
		const overlay = activeOverlay;
		activeOverlay = null;
		activeOverlayPromise = null;
		overlay?.dispose();
	});
}
