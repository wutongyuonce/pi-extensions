import type { BeforeAgentStartEvent, Skill } from "@earendil-works/pi-coding-agent";
import { PI_SUBAGENT_APPEND_SYSTEM_PROMPT } from "../launch/append-system.ts";
import {
	applySkillVisibilityToSystemPrompt,
	type SkillFileReadTool,
	PI_SUBAGENT_SKILL_VISIBILITY,
} from "../launch/skill-visibility.ts";

function getSkillFileTool(selectedTools: readonly string[] | undefined): SkillFileReadTool | undefined {
	if (!selectedTools) return "read";
	return (["read", "bash"] as const).find((tool) => selectedTools.includes(tool));
}

function composeChildSystemPrompt(
	systemPrompt: string,
	originalSystemPrompt: string,
	appendSystemPrompt: string | undefined,
): { systemPrompt: string } | undefined {
	if (!appendSystemPrompt && systemPrompt === originalSystemPrompt) return undefined;
	if (!appendSystemPrompt) return { systemPrompt };
	return { systemPrompt: `${systemPrompt}\n\n${appendSystemPrompt}` };
}

/**
 * Child-side system-prompt composition for the mandatory child extension:
 * apply skill visibility annotations first, then any inherited append-system
 * text. Returns undefined when neither changes the prompt.
 */
export function applyChildSystemPromptOverrides(
	event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">,
): { systemPrompt: string } | undefined {
	let systemPrompt = event.systemPrompt;
	const selectedTools = event.systemPromptOptions?.selectedTools;
	// Mirror pi's own gate (>= 0.85.0): the skills block renders with `read`,
	// or with `bash` when `read` is absent, and not at all without either.
	const skillFileTool = getSkillFileTool(selectedTools);
	const visibilitySpec = process.env[PI_SUBAGENT_SKILL_VISIBILITY]?.trim();
	if (visibilitySpec) {
		systemPrompt = applySkillVisibilityToSystemPrompt(
			systemPrompt,
			(event.systemPromptOptions?.skills ?? []) as Skill[],
			visibilitySpec,
			skillFileTool,
		);
	}
	const appendSystemPrompt = process.env[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]?.trim();
	return composeChildSystemPrompt(systemPrompt, event.systemPrompt, appendSystemPrompt);
}
