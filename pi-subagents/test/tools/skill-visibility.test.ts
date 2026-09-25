import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import {
	assert,
	describe,
	it,
	subagentDoneExtension,
} from "../support/index.ts";

function skill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description.`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "local", baseDir: `/skills/${name}` } as Skill["sourceInfo"],
		disableModelInvocation,
	};
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function loadHandler() {
	const handlers = new Map<string, (event: unknown) => unknown>();
	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool(definition: unknown) {
			return definition;
		},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerShortcut() {},
		registerCommand() {},
	} as any);
	return handlers.get("before_agent_start") as (event: unknown) => { systemPrompt?: string } | undefined;
}

function run(
	handler: (event: unknown) => { systemPrompt?: string } | undefined,
	systemPrompt: string,
	skills: Skill[],
	env: Record<string, string | undefined> = {},
	selectedTools?: string[],
) {
	return withEnv(env, () =>
		handler({
			type: "before_agent_start",
			prompt: "Do the task.",
			systemPrompt,
			systemPromptOptions: { cwd: process.cwd(), skills, ...(selectedTools ? { selectedTools } : {}) },
		}),
	);
}

describe("child skill visibility rewrite", () => {
	it("advertises an =auto skill that upstream frontmatter hides", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" });

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"), "context7 must be advertised");
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"), "tdd stays advertised");
		assert.ok(result?.systemPrompt?.startsWith("Base prompt."), "prefix is preserved");
	});

	it("hides an =manual skill that upstream frontmatter shows", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" });

		assert.ok(!result?.systemPrompt?.includes("<name>torpathy</name>"), "torpathy must be hidden");
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"), "tdd stays advertised");
	});

	it("removes the whole skills section when every advertised skill is manual", () => {
		const skills = [skill("tdd"), skill("torpathy", true)];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "tdd=manual" });

		assert.ok(!result?.systemPrompt?.includes("<available_skills>"), "block is removed entirely");
		assert.ok(!result?.systemPrompt?.includes("The following skills"), "intro lines are removed");
		assert.ok(result?.systemPrompt?.startsWith("Base prompt."), "prefix is preserved");
	});

	it("inserts the skills section when no skill was advertised upstream", () => {
		const skills = [skill("context7", true)];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" });

		assert.ok(result?.systemPrompt?.includes("<available_skills>"), "block is inserted");
		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"), "context7 is advertised");
	});

	it("leaves the prompt untouched without annotations or no-op annotations", () => {
		const skills = [skill("tdd")];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;

		const handler = loadHandler();

		const untouched = handler({ systemPrompt, systemPromptOptions: { skills } } as never);
		assert.equal(untouched, undefined);

		assert.equal(
			run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "tdd=auto" }),
			undefined,
		);
	});

	it("ignores annotations for skills that are not loaded", () => {
		const skills = [skill("tdd")];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, {
			PI_SUBAGENT_SKILL_VISIBILITY: "stale-skill=auto, tdd=manual",
		});

		assert.ok(!result?.systemPrompt?.includes("<name>tdd</name>"));
		assert.ok(!result?.systemPrompt?.includes("stale-skill"));
	});

	it("ignores malformed child visibility tokens while applying valid ones", () => {
		const skills = [skill("context7", true), skill("tdd"), skill("bad", true), skill("aut", true)];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, {
			PI_SUBAGENT_SKILL_VISIBILITY: ", malformed, auto, =auto, bad=banana, context7=auto",
		});

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"));
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"));
		assert.ok(!result?.systemPrompt?.includes("<name>bad</name>"));
		assert.ok(!result?.systemPrompt?.includes("<name>aut</name>"));
		assert.equal(skills.find((item) => item.name === "context7")?.disableModelInvocation, false);
		assert.equal(skills.find((item) => item.name === "bad")?.disableModelInvocation, true);
		assert.equal(skills.find((item) => item.name === "aut")?.disableModelInvocation, true);
	});

	it("ignores a child visibility spec made entirely of malformed tokens", () => {
		const skills = [skill("context7", true)];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, {
			PI_SUBAGENT_SKILL_VISIBILITY: "malformed, =auto, bad=banana",
		});

		assert.equal(result, undefined);
		assert.equal(skills[0]?.disableModelInvocation, true);
	});

	it("keeps the prompt unchanged when annotations arrive without a structured skill list", () => {
		const handler = loadHandler();

		const result = withEnv({ PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" }, () =>
			handler({ systemPrompt: "Base prompt." }),
		);

		assert.equal(result, undefined);
	});

	it("falls back to swapping the tagged block when the prompt drifted from the loaded skills", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		const stalePrompt = `Base prompt.\n${formatSkillsForPrompt([skill("tdd")])}`;
		const handler = loadHandler();

		const result = run(handler, stalePrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" });

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"));
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"));
		assert.equal(result?.systemPrompt?.match(/<available_skills>/g)?.length, 1);
	});

	it("rewrites every drifted skills section, not just the first", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		const staleSection = formatSkillsForPrompt([skill("context7")], "bash");
		const systemPrompt = `Base prompt.${staleSection}\nTail.${staleSection}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"bash",
		]);

		assert.equal(result?.systemPrompt?.match(/<available_skills>/g)?.length, 2);
		assert.ok(!result?.systemPrompt?.includes("<name>torpathy</name>"), "torpathy must be hidden in every copy");
		assert.equal(result?.systemPrompt?.match(/<name>tdd<\/name>/g)?.length, 2);
	});

	it("applies the rewrite before the append-system prompt", () => {
		const skills = [skill("context7", true)];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, {
			PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto",
			PI_SUBAGENT_APPEND_SYSTEM_PROMPT: "Extra instructions.",
		});

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"));
		assert.ok(result?.systemPrompt?.endsWith("Extra instructions."));
	});

	it("inserts a bash-worded block for a bash-only child", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" }, [
			"bash",
		]);

		assert.ok(result?.systemPrompt?.includes("<available_skills>"), "block is inserted");
		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"), "context7 is advertised");
		assert.ok(
			result?.systemPrompt?.includes("Use bash to load a skill's file"),
			"bash-only child keeps pi 0.85's bash wording",
		);
		assert.ok(
			!result?.systemPrompt?.includes("Use the read tool"),
			"a child without read must not be told to use read",
		);
		assert.equal(skills.find((s) => s.name === "context7")?.disableModelInvocation, false);
	});

	it("swaps the native bash-worded block byte-identically", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		// Pi >= 0.85.0 renders this block itself for a bash-only child.
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills, "bash")}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"bash",
		]);

		assert.ok(!result?.systemPrompt?.includes("<name>torpathy</name>"), "torpathy must be hidden");
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"), "tdd stays advertised");
		assert.ok(
			result?.systemPrompt?.includes("Use bash to load a skill's file"),
			"the swap must preserve the native bash wording",
		);
		assert.equal(result?.systemPrompt?.match(/Base prompt\./g)?.length, 1);
	});

	it("rewrites every duplicate native section, not just the first", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		// Chained prompt extensions or composed custom prompts can carry the
		// same native section twice; =manual must hold in every copy.
		const section = formatSkillsForPrompt(skills, "bash");
		const systemPrompt = `Base prompt.\n${section}\nTail.\n${section}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"bash",
		]);

		assert.ok(!result?.systemPrompt?.includes("<name>torpathy</name>"), "torpathy must be hidden in every copy");
		assert.equal(result?.systemPrompt?.match(/<available_skills>/g)?.length, 2);
		assert.ok(result?.systemPrompt?.includes("<name>tdd</name>"));
	});

	it("corrects the structured skill list without a block when no native file-read tool is available", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"exec_command",
		]);

		assert.equal(result, undefined);
		assert.equal(skills.find((s) => s.name === "torpathy")?.disableModelInvocation, true);
		assert.equal(skills.find((s) => s.name === "tdd")?.disableModelInvocation, false);
	});

	it("swaps an existing exact section even without a native file-read tool", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(handler, systemPrompt, skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"exec_command",
		]);

		const prompt = result?.systemPrompt;
		assert.ok(prompt);
		assert.ok(prompt.includes("<name>tdd</name>"));
		assert.ok(!prompt.includes("<name>torpathy</name>"));
	});

	it("keeps the annotation applied on every turn against pi's cached base prompt", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		// Pi passes the same cached base-prompt string and the same skill
		// objects on every turn of the session.
		const basePrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();
		const env = { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" };

		const turn1 = run(handler, basePrompt, skills, env);
		const turn2 = run(handler, basePrompt, skills, env);

		assert.ok(turn1?.systemPrompt?.includes("<name>context7</name>"));
		assert.ok(turn2?.systemPrompt?.includes("<name>context7</name>"), "turn 2 must not fall back to the stale base");
	});

	it("keeps =manual applied on turn 2 when append-system is composed", () => {
		const skills = [skill("tdd"), skill("torpathy")];
		const basePrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();
		const env = {
			PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual",
			PI_SUBAGENT_APPEND_SYSTEM_PROMPT: "Extra instructions.",
		};

		for (const turn of [run(handler, basePrompt, skills, env), run(handler, basePrompt, skills, env)]) {
			assert.ok(!turn?.systemPrompt?.includes("<name>torpathy</name>"), "torpathy must stay hidden");
			assert.ok(turn?.systemPrompt?.includes("<name>tdd</name>"));
			assert.ok(turn?.systemPrompt?.endsWith("Extra instructions."));
		}
	});

	it("still rewrites the prompt when read is explicitly selected", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		const systemPrompt = `Base prompt.\n${formatSkillsForPrompt(skills)}`;
		const handler = loadHandler();

		const result = run(
			handler,
			systemPrompt,
			skills,
			{ PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" },
			["read", "bash"],
		);

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"));
	});

	it("prefers read wording when both native file-read tools are selected", () => {
		const skills = [skill("context7", true)];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, { PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto" }, [
			"bash",
			"read",
		]);

		assert.ok(result?.systemPrompt?.includes("Use the read tool to load a skill's file"));
		assert.ok(!result?.systemPrompt?.includes("Use bash to load a skill's file"));
	});

	it("does not append an empty section when a manual skill is absent from the prompt", () => {
		const skills = [skill("torpathy")];
		const handler = loadHandler();

		const result = run(handler, "Base prompt.", skills, { PI_SUBAGENT_SKILL_VISIBILITY: "torpathy=manual" }, [
			"bash",
		]);

		assert.equal(result, undefined);
		assert.equal(skills[0]?.disableModelInvocation, true);
	});

	it("inserts the corrected block and keeps append-system for a bash-only child", () => {
		const skills = [skill("tdd"), skill("context7", true)];
		const handler = loadHandler();

		const result = run(
			handler,
			"Base prompt.",
			skills,
			{
				PI_SUBAGENT_SKILL_VISIBILITY: "context7=auto",
				PI_SUBAGENT_APPEND_SYSTEM_PROMPT: "Extra instructions.",
			},
			["bash"],
		);

		assert.ok(result?.systemPrompt?.includes("<name>context7</name>"));
		assert.ok(result?.systemPrompt?.includes("Use bash to load a skill's file"));
		assert.ok(result?.systemPrompt?.endsWith("Extra instructions."));
	});
});
