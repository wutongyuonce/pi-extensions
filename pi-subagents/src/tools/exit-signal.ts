import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeSubagentExitSidecar } from "../session/exit-sidecar.ts";
import {
	SUBAGENT_COMPLETION_ENTRY,
	SUBAGENT_CONTEXT_PRESSURE_FAILURE_REASON,
	SUBAGENT_CONTEXT_PRESSURE_REASON,
} from "./context-reminders.ts";
import type { FinalContextSnapshot } from "./final-context-snapshot.ts";

export interface ExitSignalWriterDeps {
	pi: Pick<ExtensionAPI, "appendEntry">;
	getFinalContextUsage(): FinalContextSnapshot | undefined;
	hasDeliveredFinalWarning(): boolean;
}

/**
 * Owns what a child records when it exits: the sidecar the parent reads, and
 * the durable completion marker the resume guard reads. Returns why the write
 * landed or did not, so callers never claim a verdict the parent will not see
 * and can still guarantee liveness when an earlier outcome already owns the
 * child: "accepted" (this write owns the sidecar), "owned" (a durable
 * non-error outcome already owns it), "no-session" (not a subagent context).
 */
interface ExitClassification {
	isNormalCompletion: boolean;
	contextPressure: boolean;
	failedWhileSpent: boolean;
}

/**
 * Decide whether a payload is a child-decided completion and which context
 * pressure markers it must carry. Pure classification, separate from writing.
 */
function classifyExitPayload(
	deps: ExitSignalWriterDeps,
	payload: object,
	opts?: { supersede?: boolean; autonomous?: boolean },
): ExitClassification {
	const type = (payload as { type?: unknown }).type;
	// Only a normal completion the child itself decided can be owned by the
	// context policy. Errors, pings, and lifecycle shutdowns such as an
	// operator closing the pane must never be labelled an instructed wrap-up.
	const isNormalCompletion = type === "done";
	const finalWarningHeld = deps.hasDeliveredFinalWarning();
	return {
		isNormalCompletion,
		contextPressure: isNormalCompletion && opts?.autonomous !== false && finalWarningHeld,
		// A failure is not an instructed wrap-up, but the parent still needs to
		// know the context was spent so it can choose between a cheap retry and
		// a fresh child. This never blocks resume.
		failedWhileSpent: type === "error" && finalWarningHeld,
	};
}

export function createExitSignalWriter(deps: ExitSignalWriterDeps) {
	return function writeExitSignal(payload: object, opts?: { supersede?: boolean; autonomous?: boolean }) {
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (!sessionFile) return "no-session" as const;
		const { isNormalCompletion, contextPressure, failedWhileSpent } = classifyExitPayload(deps, payload, opts);
		const accepted = writeSubagentExitSidecar(
			sessionFile,
			{
				...payload,
				...deps.getFinalContextUsage(),
				...(contextPressure ? { completionReason: SUBAGENT_CONTEXT_PRESSURE_REASON } : {}),
				...(failedWhileSpent ? { completionReason: SUBAGENT_CONTEXT_PRESSURE_FAILURE_REASON } : {}),
			},
			{ supersede: opts?.supersede },
		);
		// Record only the outcome the parent will actually read. A refused write
		// means a ping or an earlier completion already owns this child, and
		// caller_ping in particular promises the parent can resume it.
		if (!accepted) return "owned" as const;
		if (!isNormalCompletion) return "accepted" as const;
		try {
			deps.pi.appendEntry(SUBAGENT_COMPLETION_ENTRY, {
				reason: contextPressure ? SUBAGENT_CONTEXT_PRESSURE_REASON : "normal",
			});
		} catch {}
		return "accepted" as const;
	};
}
