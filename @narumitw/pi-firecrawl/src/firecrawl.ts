import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasApiKey } from "./client.js";
import { loadSettings } from "./settings.js";
import {
	allFirecrawlTools,
	applyFirecrawlTools,
	buildCommandGuide,
	buildConfigMessage,
	buildStatusMessage,
	clearSettingsNotice,
	recordSettingsNotice,
	showToolSelector,
	updateFirecrawlTools,
} from "./tool-selector.js";
import { crawlStatusTool, crawlTool, mapTool, scrapeTool, searchTool } from "./tools.js";

const STATUS_KEY = "firecrawl";
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "config", label: "config", description: "Show configuration quick start" },
	{ value: "quickstart", label: "quickstart", description: "Show configuration quick start" },
	{ value: "status", label: "status", description: "Show tool and settings status" },
	{ value: "tools", label: "tools", description: "Select Firecrawl tools" },
	{ value: "toggle", label: "toggle", description: "Select Firecrawl tools" },
	{ value: "enable", label: "enable", description: "Enable all Firecrawl tools" },
	{ value: "disable", label: "disable", description: "Disable all Firecrawl tools" },
];
const MENU_OPTIONS = {
	config: "Configuration quick start",
	help: "Command usage guide",
	status: "Show tool status",
	tools: "Select Firecrawl tools",
	enable: "Enable all Firecrawl tools",
	disable: "Disable all Firecrawl tools",
} as const;
type CommandAction =
	| "menu"
	| "help"
	| "config"
	| "quickstart"
	| "status"
	| "tools"
	| "enable"
	| "disable";
type CommandContext = ExtensionCommandContext;
export default function firecrawl(pi: ExtensionAPI) {
	pi.registerTool(scrapeTool);
	pi.registerTool(crawlTool);
	pi.registerTool(crawlStatusTool);
	pi.registerTool(mapTool);
	pi.registerTool(searchTool);

	pi.registerCommand("firecrawl", {
		description: "Open Firecrawl help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleFirecrawlCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearSettingsNotice();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const settings = await loadSettings();
		recordSettingsNotice(settings);
		if (settings.notice) ctx.ui.notify(settings.notice, "warning");
		if (settings.kind === "loaded") {
			applyFirecrawlTools(pi, settings.settings.tools);
			return;
		}
		if (settings.kind === "invalid") {
			ctx.ui.notify(`Firecrawl settings ignored: ${settings.reason}`, "warning");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function handleFirecrawlCommand(pi: ExtensionAPI, args: string, ctx: CommandContext) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "config":
		case "quickstart":
			ctx.ui.notify(buildConfigMessage(), hasApiKey() ? "info" : "warning");
			return;
		case "status":
			ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
			return;
		case "tools":
			await showToolSelector(pi, ctx);
			return;
		case "enable":
			await updateFirecrawlTools(pi, ctx, allFirecrawlTools(), "enabled all");
			return;
		case "disable":
			await updateFirecrawlTools(pi, ctx, [], "disabled all");
			return;
	}

	ctx.ui.notify(`Unknown /firecrawl command: ${args.trim()}\n\n${buildCommandGuide()}`, "warning");
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`${buildCommandGuide()}\n\n${await buildStatusMessage(pi)}`,
			hasApiKey() ? "info" : "warning",
		);
		return;
	}

	const choice = await ctx.ui.select("Firecrawl", Object.values(MENU_OPTIONS));
	switch (choice) {
		case MENU_OPTIONS.config:
			ctx.ui.notify(buildConfigMessage(), hasApiKey() ? "info" : "warning");
			return;
		case MENU_OPTIONS.help:
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case MENU_OPTIONS.status:
			ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
			return;
		case MENU_OPTIONS.tools:
			await showToolSelector(pi, ctx);
			return;
		case MENU_OPTIONS.enable:
			await updateFirecrawlTools(pi, ctx, allFirecrawlTools(), "enabled all");
			return;
		case MENU_OPTIONS.disable:
			await updateFirecrawlTools(pi, ctx, [], "disabled all");
			return;
	}
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "config") return "config";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/.test(normalized)) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) =>
		completion.value.startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

export {
	cleanObject,
	formatPayload,
	jsonResult,
	normalizeApiUrl,
	parseResponseBody,
} from "./client.js";
export { installSettingsFileExclusively, normalizeFirecrawlSettings } from "./settings.js";
export { formatPersistedSelection, orderedFirecrawlTools } from "./tool-selector.js";
