import type { OrchestratorSnapshot } from "../../runtime/orchestrator-controller.ts";
import { fitLine, renderScrollbar, wrapPlainText } from "./render-helpers.ts";
import type { OrchestratorActionId, Theme } from "./render-types.ts";

export interface OrchestratorAction {
	id: OrchestratorActionId;
	label: string;
	disabled: boolean;
	targetMode?: boolean;
	description?: string;
}

interface LayoutLine {
	text: string;
	tone?: string;
	actionIndex?: number;
}

interface OrchestratorLayout {
	statusLines: LayoutLine[];
	lines: LayoutLine[];
	actionRanges: Array<{ start: number; end: number }>;
}

const MAX_WRAP_LINES = Number.MAX_SAFE_INTEGER;

export function getOrchestratorActions(
	snapshot: OrchestratorSnapshot,
): OrchestratorAction[] {
	const sessionBlocked = snapshot.blockedReason !== null;
	return [
		{
			id: "session-toggle",
			label: snapshot.currentMode
				? "Disable in this session"
				: "Enable in this session",
			disabled: sessionBlocked,
			targetMode: !snapshot.currentMode,
			description:
				"In-place: keeps conversation/context; prompt/tool changes may reduce cache reuse.",
		},
		{
			id: "session-fresh",
			label: snapshot.currentMode
				? "Start a fresh normal session…"
				: "Start a fresh orchestrator session…",
			disabled: sessionBlocked,
			targetMode: !snapshot.currentMode,
			description:
				"Fresh: empty conversation; old session remains available via /resume.",
		},
		{
			id: "default-toggle",
			label:
				"Default for new sessions: " + modeLabel(snapshot.savedGlobalDefault),
			disabled: false,
		},
	];
}

export function getOrchestratorGuardMessage(
	snapshot: OrchestratorSnapshot,
): string | undefined {
	if (!snapshot.blockedReason) return undefined;
	const reason =
		snapshot.blockedReason === "running-subagents"
			? "children are running"
			: snapshot.blockedReason === "parent-busy"
				? "the parent is running, retrying, or compacting"
				: snapshot.blockedReason === "pending-messages"
					? "pending messages are queued"
					: snapshot.blockedReason === "child-session"
						? "this is a child session"
						: "the session context is unavailable";
	if (snapshot.blockedReason === "child-session") {
		return (
			"Orchestrator controls unavailable: " +
			reason +
			"; child sessions cannot change parent or global orchestration."
		);
	}
	const subject =
		snapshot.blockedReason === "running-subagents"
			? "children are running"
			: snapshot.blockedReason === "parent-busy"
				? "the parent is busy"
				: "pending messages are queued";
	return (
		"Session changes unavailable: " + subject + "; wait or stop explicitly."
	);
}

function getOrchestratorError(
	snapshot: OrchestratorSnapshot,
	localError?: string,
): string | undefined {
	return localError ?? snapshot.persistenceError ?? snapshot.globalConfigError;
}

export function renderOrchestrator(
	snapshot: OrchestratorSnapshot,
	selectedIndex: number,
	scroll: number,
	theme: Theme,
	width: number,
	maxHeight: number,
	localError?: string,
): string[] {
	const layout = buildLayout(snapshot, Math.max(8, width - 2), localError);
	const height = Math.max(1, maxHeight);
	const statusLines = selectStatusLines(
		snapshot,
		layout.statusLines,
		height,
		width,
	);
	const actionHeight = Math.max(1, height - statusLines.length);
	const clampedScroll = clampScroll(scroll, layout.lines.length, actionHeight);
	const visible = [
		...statusLines,
		...layout.lines.slice(clampedScroll, clampedScroll + actionHeight),
	];
	const contentWidth = Math.max(1, width - 2);

	return visible.map((line, index) => {
		let text = line.text;
		if (line.tone) text = theme.fg(line.tone, text);
		text = fitLine(text, contentWidth);
		if (line.actionIndex === selectedIndex) text = theme.bg("selectedBg", text);
		const isActionLine = index >= statusLines.length;
		const gutter = isActionLine
			? renderScrollbar(
					index - statusLines.length,
					actionHeight,
					layout.lines.length,
					clampedScroll,
					theme,
				)
			: " ";
		return fitLine(text + " " + gutter, width);
	});
}

export function keepOrchestratorSelectionVisible(
	snapshot: OrchestratorSnapshot,
	selectedIndex: number,
	scroll: number,
	width: number,
	maxHeight: number,
	localError?: string,
): number {
	const layout = buildLayout(snapshot, Math.max(8, width - 2), localError);
	const range = layout.actionRanges[selectedIndex];
	if (!range) return 0;
	const statusLines = selectStatusLines(
		snapshot,
		layout.statusLines,
		maxHeight,
		width,
	);
	const height = Math.max(1, maxHeight - statusLines.length);
	if (range.start < scroll) return range.start;
	if (range.start >= scroll + height)
		return Math.max(0, range.start - height + 1);
	return clampScroll(scroll, layout.lines.length, height);
}

export function renderOrchestratorConfirmation(
	targetMode: boolean,
	confirmed: boolean,
	theme: Theme,
	width: number,
	maxHeight = Number.MAX_SAFE_INTEGER,
): string[] {
	const contentWidth = Math.max(8, width - 2);
	const target = targetMode ? "orchestrator" : "normal";
	const selected = (text: string, isSelected: boolean) =>
		isSelected ? theme.bg("selectedBg", text) : text;
	const buttons =
		"  " +
		selected(" Cancel ", !confirmed) +
		"  " +
		selected(" Start ", confirmed);
	const lines: string[] = [
		" " + theme.fg("warning", "Start a fresh " + target + " session?"),
		...wrapPlainText(
			"  Fresh session: empty conversation; this session remains available via /resume.",
			contentWidth,
			MAX_WRAP_LINES,
		).map((line) => "  " + theme.fg("muted", line)),
		"",
		buttons,
	];
	const fitted = lines.map((line) => fitLine(line, width));
	const height = Math.max(1, maxHeight);
	if (fitted.length <= height) return fitted;
	if (height === 1) {
		return [
			fitLine(
				` ${target} session: ${selected("Cancel", !confirmed)} / ${selected("Start", confirmed)}`,
				width,
			),
		];
	}
	return [fitted[0], fitted.at(-1) ?? buttons].slice(0, height);
}

function buildLayout(
	snapshot: OrchestratorSnapshot,
	width: number,
	localError?: string,
): OrchestratorLayout {
	const statusLines: LayoutLine[] = [];
	const lines: LayoutLine[] = [];
	const actionRanges: Array<{ start: number; end: number }> = [];
	const addStatus = (text: string, tone?: string) => {
		const wrapped = wrapPlainText(text, Math.max(8, width), MAX_WRAP_LINES);
		for (const line of wrapped) statusLines.push({ text: line, tone });
	};
	const addWrapped = (
		text: string,
		tone?: string,
		actionIndex?: number,
		prefix = "",
	) => {
		const wrapped = wrapPlainText(
			text,
			Math.max(8, width - prefix.length),
			MAX_WRAP_LINES,
		);
		for (let i = 0; i < wrapped.length; i++) {
			lines.push({
				text: (i === 0 ? prefix : " ".repeat(prefix.length)) + wrapped[i],
				tone,
				actionIndex,
			});
		}
	};

	addStatus("Current session: " + modeLabel(snapshot.currentMode), "accent");
	const guard = getOrchestratorGuardMessage(snapshot);
	if (guard) addStatus(renderGuardStatus(snapshot, width), "warning");
	addStatus(
		width < 20
			? `P:${snapshot.parentIdle === true ? "idle" : "busy"} k:${snapshot.runningSubagents}`
			: width < 32
				? `Parent ${snapshot.parentIdle === true ? "idle" : "busy"} · kids ${snapshot.runningSubagents}`
				: width < 40
					? `Parent ${snapshot.parentIdle === true ? "idle" : "busy"} · children ${snapshot.runningSubagents}`
					: "Parent: " +
						(snapshot.parentIdle === true ? "idle" : "busy") +
						" · Running children: " +
						snapshot.runningSubagents,
	);

	if (width >= 32)
		addStatus("Delegate-only: coordination tools only.", "muted");

	addWrapped("Session actions", "accent");
	for (const [index, action] of getOrchestratorActions(snapshot).entries()) {
		if (action.id === "default-toggle") continue;
		const start = lines.length;
		const suffix = action.disabled ? " (unavailable)" : "";
		addWrapped(
			action.label + suffix,
			action.disabled ? "dim" : "text",
			index,
			"  ",
		);
		const labelEnd = lines.length;
		if (action.description)
			addWrapped(action.description, "muted", index, "    ");
		actionRanges[index] = { start, end: labelEnd };
	}

	lines.push({ text: "" });
	addWrapped("Global preference", "accent");
	const globalAction = getOrchestratorActions(snapshot)[2];
	if (globalAction) {
		const start = lines.length;
		const globalLabel =
			width < 20
				? `Default: ${modeLabel(snapshot.savedGlobalDefault)}`
				: globalAction.label;
		addWrapped(globalLabel, "text", 2, "  ");
		actionRanges[2] = { start, end: lines.length };
	}
	const error = getOrchestratorError(snapshot, localError);
	if (error) addWrapped("Error: " + error, "error", 2);

	addWrapped(
		"saved: " +
			modeLabel(snapshot.savedGlobalDefault) +
			" · effective: " +
			modeLabel(snapshot.effectiveGlobalDefault),
		"muted",
	);
	if (snapshot.effectiveGlobalDefaultSource === "env") {
		addWrapped(
			"PI_ORCHESTRATOR_MODE override is controlling the effective default.",
			"warning",
		);
	} else if (snapshot.effectiveGlobalDefaultSource === "invalid-env") {
		addWrapped(
			"PI_ORCHESTRATOR_MODE override is invalid; using the safe default.",
			"warning",
		);
	}
	addWrapped(
		"Changing this default does not switch the current session.",
		"muted",
	);

	return { statusLines, lines, actionRanges };
}

function selectStatusLines(
	snapshot: OrchestratorSnapshot,
	statusLines: LayoutLine[],
	height: number,
	width: number,
): LayoutLine[] {
	const maxStatusLines =
		height > 1 ? Math.max(1, Math.min(4, Math.max(0, height - 3))) : 0;
	if (maxStatusLines === 0) return [];
	if (statusLines.length <= maxStatusLines) return statusLines;
	if (maxStatusLines === 1 && snapshot.blockedReason) {
		const mode = statusLines[0]?.text ?? "Current session";
		return [
			{
				text: mode + " · " + compactGuardStatus(snapshot, width),
				tone: "warning",
			},
		];
	}
	return statusLines.slice(0, maxStatusLines);
}

function compactGuardStatus(
	snapshot: OrchestratorSnapshot,
	width: number,
): string {
	if (width < 32) {
		if (snapshot.blockedReason === "running-subagents") return "children busy";
		if (snapshot.blockedReason === "parent-busy") return "parent busy";
		if (snapshot.blockedReason === "pending-messages") return "messages queued";
		if (snapshot.blockedReason === "child-session") return "child session";
		return "context unavailable";
	}
	return renderGuardStatus(snapshot, width);
}

function renderGuardStatus(
	snapshot: OrchestratorSnapshot,
	width: number,
): string {
	if (width >= 40) return getOrchestratorGuardMessage(snapshot) ?? "";
	if (width < 20) {
		if (snapshot.blockedReason === "running-subagents") return "Busy: children";
		if (snapshot.blockedReason === "parent-busy") return "Busy: parent";
		if (snapshot.blockedReason === "pending-messages") return "Queued messages";
		if (snapshot.blockedReason === "child-session") return "Child session";
		return "No session context";
	}
	if (snapshot.blockedReason === "running-subagents")
		return "Blocked: children running; wait or stop.";
	if (snapshot.blockedReason === "parent-busy")
		return "Blocked: parent busy; wait or stop.";
	if (snapshot.blockedReason === "pending-messages")
		return "Blocked: pending messages; wait or stop.";
	if (snapshot.blockedReason === "child-session")
		return "Blocked: child session; parent/global controls unavailable.";
	return "Blocked: session context unavailable.";
}

function modeLabel(enabled: boolean): string {
	return enabled ? "On" : "Off";
}

function clampScroll(
	scroll: number,
	totalLines: number,
	height: number,
): number {
	return Math.max(0, Math.min(scroll, Math.max(0, totalLines - height)));
}
