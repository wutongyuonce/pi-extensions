import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Custom session-entry type used for orchestrator mode state. */
export const ORCHESTRATOR_SESSION_CUSTOM_TYPE = "pi-subagents:orchestrator";
const ORCHESTRATOR_SESSION_STATE_VERSION = 1;

/** Current orchestrator state read from a session branch. */
export interface OrchestratorSessionState {
	enabled: boolean;
	activeTools?: string[];
}

/** Serialized session state written as a versioned custom entry. */
export interface PersistedOrchestratorSessionState
	extends OrchestratorSessionState {
	version: 1;
}

type SessionEntryWriter = Pick<SessionManager, "appendCustomEntry">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(entry: SessionEntry): OrchestratorSessionState | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== ORCHESTRATOR_SESSION_CUSTOM_TYPE
	)
		return undefined;
	if (!isRecord(entry.data)) return undefined;
	if (entry.data.version !== ORCHESTRATOR_SESSION_STATE_VERSION)
		return undefined;
	if (typeof entry.data.enabled !== "boolean") return undefined;
	const activeTools = Array.isArray(entry.data.activeTools)
		? entry.data.activeTools.filter(
				(name): name is string => typeof name === "string",
			)
		: undefined;
	return {
		enabled: entry.data.enabled,
		...(activeTools ? { activeTools: [...new Set(activeTools)] } : {}),
	};
}

/** Build the versioned state payload stored in a session entry. */
export function buildOrchestratorSessionState(
	enabled: boolean,
	activeTools?: readonly string[],
): PersistedOrchestratorSessionState {
	return {
		version: ORCHESTRATOR_SESSION_STATE_VERSION,
		enabled,
		...(activeTools ? { activeTools: [...new Set(activeTools)] } : {}),
	};
}

/** Append orchestrator state to a session manager. */
export function appendOrchestratorSessionState(
	sessionManager: SessionEntryWriter,
	enabled: boolean,
	activeTools?: readonly string[],
): string {
	return sessionManager.appendCustomEntry(
		ORCHESTRATOR_SESSION_CUSTOM_TYPE,
		buildOrchestratorSessionState(enabled, activeTools),
	);
}

/** Read the latest valid orchestrator state from a session branch. */
export function readOrchestratorSessionState(
	branch: readonly SessionEntry[],
): OrchestratorSessionState | undefined {
	let latest: OrchestratorSessionState | undefined;
	for (const entry of branch) {
		const state = parseState(entry);
		if (state) latest = state;
	}
	return latest;
}
