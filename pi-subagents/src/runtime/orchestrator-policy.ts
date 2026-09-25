import { ORCHESTRATOR_ALLOWED_TOOL_NAMES } from "../tools/tool-names.ts";

function isNonEmpty(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Identify child launches from the environment values injected at launch time. */
export function isSubagentChildEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return [
		"PI_SUBAGENT_AGENT",
		"PI_SUBAGENT_PARENT_SESSION",
		"PI_SUBAGENT_NAME",
		"PI_SUBAGENT_SESSION",
		"PI_SUBAGENT_SURFACE",
	].some((key) => isNonEmpty(env[key]));
}

/** Normalize active-tool snapshots before comparing or persisting them. */
export function normalizeOrchestratorTools(
	toolNames: readonly string[],
): string[] {
	return [
		...new Set(
			toolNames.filter((name) => typeof name === "string" && name.length > 0),
		),
	];
}

/** Compare normalized tool snapshots in their registered order. */
export function sameOrchestratorTools(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((name, index) => name === right[index])
	);
}

/** Restrict a saved baseline to tools available in the new runtime. */
function intersectOrchestratorTools(
	preferred: readonly string[],
	available: readonly string[],
): string[] {
	const availableTools = new Set(available);
	return preferred.filter((name) => availableTools.has(name));
}

/** Keep only tools allowed for orchestration. */
export function filterOrchestratorTools(
	toolNames: readonly string[],
): string[] {
	return normalizeOrchestratorTools(toolNames).filter((name) =>
		ORCHESTRATOR_ALLOWED_TOOL_NAMES.has(name),
	);
}

/** Identify a live tool set restricted by the prior orchestrator mode. */
export function currentToolsAreControllerRestricted(
	previousMode: boolean,
	currentTools: readonly string[],
): boolean {
	return (
		previousMode &&
		currentTools.every((name) => ORCHESTRATOR_ALLOWED_TOOL_NAMES.has(name))
	);
}

/** Restore branch tool policy without granting unavailable startup tools. */
export function chooseOrchestratorBaseline(
	persistedTools: readonly string[] | undefined,
	previousMode: boolean,
	currentTools: readonly string[],
	previousNormalTools: readonly string[],
	isFreshRuntime: boolean,
): string[] {
	if (persistedTools && sameOrchestratorTools(currentTools, persistedTools))
		return [...persistedTools];
	// A fresh controller has no live reconfiguration history. Keep the
	// persisted baseline, but never restore tools absent from this startup.
	if (isFreshRuntime && persistedTools)
		return intersectOrchestratorTools(persistedTools, currentTools);
	if (currentToolsAreControllerRestricted(previousMode, currentTools)) {
		return [...(persistedTools ?? previousNormalTools ?? currentTools)];
	}
	return [...currentTools];
}

/** Restore normal tools while respecting visible live tool changes. */
export function deriveNormalToolsOnDisable(
	currentTools: readonly string[],
	normalActiveTools: readonly string[],
	modeActiveTools: readonly string[],
): string[] {
	const liveTools = normalizeOrchestratorTools(currentTools);
	if (liveTools.some((name) => !ORCHESTRATOR_ALLOWED_TOOL_NAMES.has(name)))
		return liveTools;

	const expected =
		modeActiveTools.length > 0
			? modeActiveTools
			: filterOrchestratorTools(normalActiveTools);
	const missingAllowed = new Set(
		expected.filter((name) => !liveTools.includes(name)),
	);
	const next = normalActiveTools.filter((name) => !missingAllowed.has(name));
	for (const name of liveTools) {
		if (!next.includes(name)) next.push(name);
	}
	return next;
}
