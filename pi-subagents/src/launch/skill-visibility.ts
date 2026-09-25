import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/** Env var carrying `name=auto|manual` annotations from parent to child. */
export const PI_SUBAGENT_SKILL_VISIBILITY = "PI_SUBAGENT_SKILL_VISIBILITY";

/** Tool pi (>= 0.85.0) uses to load SKILL.md files for advertised skills. */
export type SkillFileReadTool = "read" | "bash";

type SkillVisibility = "auto" | "manual";

export interface SkillListEntry {
	name: string;
	visibility?: SkillVisibility;
}

/**
 * Split a `skills:`/`PI_SUBAGENT_SKILL_VISIBILITY` style list into entries,
 * validating the inline `=auto`/`=manual` annotation grammar.
 *
 * Throws at launch time on unknown annotation values, annotations on
 * `all`/`none`, and conflicting annotations for the same name, so a typo can
 * never silently change what a child advertises.
 */
export function parseSkillListEntries(raw: string | undefined): SkillListEntry[] {
	if (!raw?.trim()) return [];
	const entries: SkillListEntry[] = [];
	const seen = new Map<string, SkillVisibility | null>();
	for (const token of raw.split(",")) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const separator = trimmed.indexOf("=");
		const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
		const annotation = separator === -1 ? null : trimmed.slice(separator + 1);
		if (!name) throw new Error(`Invalid skills entry: "${trimmed}".`);
		if (annotation !== null) {
			if (annotation !== "auto" && annotation !== "manual") {
				throw new Error(
					`Invalid skill visibility annotation "${annotation}" in "${trimmed}". Use "=auto" or "=manual".`,
				);
			}
			if (name === "all" || name === "none") {
				throw new Error(
					`Visibility annotations are only valid on named skills in an allowlist (got "${trimmed}").`,
				);
			}
		}
		if (seen.has(name)) {
			if ((seen.get(name) ?? null) !== annotation) {
				throw new Error(`Conflicting visibility annotations for skill "${name}".`);
			}
		}
		seen.set(name, annotation);
		// Multiplicity is preserved (plain duplicates keep their historical
		// launch-arg and mixed-form error behavior); `seen` exists only to
		// detect conflicting annotations for the same name.
		entries.push(annotation ? { name, visibility: annotation } : { name });
	}
	return entries;
}

/** Serialize annotated entries back to the env grammar (`context7=auto,tdd=manual`). */
export function serializeSkillVisibility(entries: SkillListEntry[]): string {
	return entries
		.filter((entry) => entry.visibility)
		.map((entry) => `${entry.name}=${entry.visibility}`)
		.join(",");
}

/**
 * Derive the visibility spec from a raw `skills:` value. Lenient by design:
 * the launch plan validated the grammar already, and resume/wrap-up paths must
 * never crash on stale persisted values.
 */
export function getSkillVisibilitySpec(rawSkills: string | undefined): string {
	try {
		return serializeSkillVisibility(parseSkillListEntries(rawSkills));
	} catch {
		return "";
	}
}

/**
 * Parse the env var grammar in the child. Junk is ignored rather than fatal:
 * the parent validated this value at launch; a stale or tampered env var must
 * never break the child's prompt.
 */
function parseVisibilitySpec(raw: string): Map<string, SkillVisibility> {
	const map = new Map<string, SkillVisibility>();
	for (const token of raw.split(",")) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;
		const name = trimmed.slice(0, separator);
		const value = trimmed.slice(separator + 1);
		if (!name || (value !== "auto" && value !== "manual")) continue;
		map.set(name, value);
	}
	return map;
}

/**
 * Original `disableModelInvocation` flags, captured before the first
 * correction. Pi passes the same skill objects and the same cached base
 * prompt on every turn of a session, so after the first correction the live
 * flags no longer match what the cached prompt was rendered from — the
 * "before" section must be reconstructed from these originals or the
 * correction would silently revert from turn 2 on.
 */
const originalFlags = new WeakMap<Skill, boolean>();

function captureOriginalFlags(skills: Skill[]): void {
	for (const skill of skills) {
		if (!originalFlags.has(skill)) originalFlags.set(skill, skill.disableModelInvocation);
	}
}

function renderOriginalSection(skills: Skill[], fileReadTool: SkillFileReadTool): string {
	const hasCached = skills.some((skill) => originalFlags.has(skill));
	if (!hasCached) return formatSkillsForPrompt(skills, fileReadTool);
	return formatSkillsForPrompt(
		skills.map((skill) => {
			const original = originalFlags.get(skill);
			return original === undefined ? skill : { ...skill, disableModelInvocation: original };
		}),
		fileReadTool,
	);
}

function applyVisibilityAnnotations(skills: Skill[], annotations: Map<string, SkillVisibility>): void {
	for (const skill of skills) {
		const annotation = annotations.get(skill.name);
		if (!annotation) continue;
		const hidden = annotation === "manual";
		if (skill.disableModelInvocation === hidden) continue;
		skill.disableModelInvocation = hidden;
	}
}

function replaceExactSkillSection(systemPrompt: string, current: string, next: string): string | undefined {
	if (!current) return undefined;
	if (!systemPrompt.includes(current)) return undefined;
	return systemPrompt.replaceAll(current, () => next);
}

function replaceDriftedSkillSections(systemPrompt: string, next: string): string {
	const section =
		/(?:\n\nThe following skills provide specialized instructions for specific tasks\.\n[^\n]*\n[^\n]*\n\n)?<available_skills>[\s\S]*?<\/available_skills>/g;
	if (section.test(systemPrompt)) {
		return systemPrompt.replace(section, () => next);
	}
	return next ? `${systemPrompt}${next}` : systemPrompt;
}

function reconcileSkillSections(
	systemPrompt: string,
	current: string,
	next: string,
	skillFileTool: SkillFileReadTool | undefined,
): string {
	if (current === next) return systemPrompt;
	const exactReplacement = replaceExactSkillSection(systemPrompt, current, next);
	if (exactReplacement !== undefined) return exactReplacement;
	if (!skillFileTool) return systemPrompt;
	return replaceDriftedSkillSections(systemPrompt, next);
}

/**
 * Rewrite the `<available_skills>` section of a child system prompt so inline
 * annotations win over the skill frontmatter flags:
 *
 * - `=auto` advertises a skill whose `disable-model-invocation` frontmatter
 *   (or the global manual list materialized into it) would hide it.
 * - `=manual` hides a skill from this child only, wherever else it is visible.
 *
 * The old and new sections are rendered with Pi's own formatter, using the
 * child's own file-read tool (`read`, or `bash` when `read` is absent — the
 * same gate and wording pi >= 0.85.0 uses for its own block), so the swap is
 * byte-identical to a native render. The structured skill list is also
 * corrected in place: any later `before_agent_start` handler that rebuilds a
 * skills section from `systemPromptOptions.skills` (adapter extensions
 * replacing Pi's native tools, for example) inherits the override instead of
 * re-applying the frontmatter flags. Without `read` or `bash` no block is
 * ever inserted — pi withholds it there, and a child that cannot load skills
 * through native tooling must not get one — while the structured correction
 * still flows downstream. Nothing on disk is touched: skill files are managed
 * externally (skill managers such as `npx skills`) and must not be healed
 * per-child.
 */
export function applySkillVisibilityToSystemPrompt(
	systemPrompt: string,
	skills: Skill[],
	rawVisibility: string,
	skillFileTool?: SkillFileReadTool,
): string {
	const annotations = parseVisibilitySpec(rawVisibility);
	if (annotations.size === 0) return systemPrompt;
	// Capture each skill's original flag before the first correction, then
	// render the "before" section from those originals — the live objects are
	// corrected in place below, and pi's cached prompt still reflects the
	// originals on every later turn of the session.
	captureOriginalFlags(skills);
	const renderTool = skillFileTool ?? "read";
	const current = renderOriginalSection(skills, renderTool);
	applyVisibilityAnnotations(skills, annotations);
	// Always render from the live (corrected) list: on later turns the
	// correction is already in place, but the cached prompt still holds the
	// pre-correction section, so the reconcile must run every turn. A genuine
	// no-op annotation makes `current === next` and returns early below.
	const next = formatSkillsForPrompt(skills, renderTool);
	return reconcileSkillSections(systemPrompt, current, next, skillFileTool);
}
