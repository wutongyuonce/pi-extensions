import {
	assert,
	buildSkillLaunchPlanForTest,
	createTestDir,
	describe,
	getBaseSubagentEnvVarsForTest,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";
import { getSkillVisibilitySpec } from "../../src/launch/skill-visibility.ts";

function writeSkill(root: string, name: string, description = `${name} skill.`): string {
	const skillDir = join(root, "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}`);
	return filePath;
}

describe("skill visibility annotations", () => {
	it("parses =auto and =manual annotations while keeping plain names working", async () => {
		const dir = createTestDir();
		const context7 = writeSkill(dir, "context7");
		const torpathy = writeSkill(dir, "torpathy");
		const tdd = writeSkill(dir, "tdd");

		const plan = await buildSkillLaunchPlanForTest("context7=auto, torpathy=manual, tdd", undefined, dir, dir);

		assert.deepEqual(plan.availability.mode === "only" ? plan.availability.names : [], [
			"context7",
			"torpathy",
			"tdd",
		]);
		assert.deepEqual(plan.launchArgs, [
			"--no-skills",
			"--skill",
			context7,
			"--skill",
			torpathy,
			"--skill",
			tdd,
		]);
		assert.equal(plan.visibilitySpec, "context7=auto,torpathy=manual");
	});

	it("keeps all and none free of annotations", async () => {
		const dir = createTestDir();
		assert.equal((await buildSkillLaunchPlanForTest("all", undefined, dir, dir)).visibilitySpec, "");
		assert.equal((await buildSkillLaunchPlanForTest(undefined, undefined, dir, dir)).visibilitySpec, "");
		assert.equal((await buildSkillLaunchPlanForTest("none", undefined, dir, dir)).visibilitySpec, "");
		const plain = await buildSkillLaunchPlanForTest("tdd", undefined, dir, dir);
		assert.equal(plain.visibilitySpec, "");
	});

	it("rejects unknown annotation values with a clear error", async () => {
		const dir = createTestDir();
		writeSkill(dir, "context7");
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("context7=banana", undefined, dir, dir),
			/Invalid skill visibility annotation "banana".*=auto.*=manual/s,
		);
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("context7=", undefined, dir, dir),
			/Invalid skill visibility annotation/,
		);
	});

	it("rejects annotations on all and none", async () => {
		const dir = createTestDir();
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("all=auto", undefined, dir, dir),
			/Visibility annotations.*allowlist.*all=auto/s,
		);
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("none=manual", undefined, dir, dir),
			/Visibility annotations.*allowlist.*none=manual/s,
		);
	});

	it("rejects conflicting annotations for the same skill", async () => {
		const dir = createTestDir();
		writeSkill(dir, "tdd");
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("tdd=auto, tdd=manual", undefined, dir, dir),
			/Conflicting visibility annotations for skill "tdd"/,
		);
	});

	it("still resolves annotated names against discovered skills", async () => {
		const dir = createTestDir();
		writeSkill(dir, "tdd");
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("missing-skill=auto", undefined, dir, dir),
			/Unknown skill: missing-skill$/,
		);
	});

	it("rejects annotations in inject-skills", async () => {
		const dir = createTestDir();
		writeSkill(dir, "tdd");
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("tdd", "tdd=auto", dir, dir),
			/inject-skills does not accept visibility annotations/,
		);
	});

	it("forwards resolved visibility to the child environment", () => {
		const env = getBaseSubagentEnvVarsForTest({
			skills: "context7=auto, torpathy=manual, tdd",
		});
		assert.equal(env.PI_SUBAGENT_SKILL_VISIBILITY, "context7=auto,torpathy=manual");
	});

	it("clears the visibility env var without annotations", () => {
		const env = getBaseSubagentEnvVarsForTest({ skills: "tdd, torpathy" });
		assert.equal(env.PI_SUBAGENT_SKILL_VISIBILITY, "");
		assert.equal(getBaseSubagentEnvVarsForTest(null).PI_SUBAGENT_SKILL_VISIBILITY, "");
	});

	it("drops malformed persisted visibility instead of throwing", () => {
		assert.equal(getSkillVisibilitySpec("context7=banana"), "");
		assert.equal(getSkillVisibilitySpec("=auto"), "");
		assert.equal(getSkillVisibilitySpec(" , context7=auto"), "context7=auto");
		assert.equal(getSkillVisibilitySpec("context7=auto"), "context7=auto");
	});

	it("overrides an inherited or frontmatter-injected visibility env value", () => {
		const env = getBaseSubagentEnvVarsForTest({
			skills: "tdd",
			env: "PI_SUBAGENT_SKILL_VISIBILITY=context7=auto",
		});
		assert.equal(env.PI_SUBAGENT_SKILL_VISIBILITY, "");
	});

	it("still rejects mixed forms like all,all and none,none", async () => {
		const dir = createTestDir();
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("all,all", undefined, dir, dir),
			/do not mix these forms/,
		);
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("none,none", undefined, dir, dir),
			/do not mix these forms/,
		);
	});

	it("preserves duplicate plain entries in launch args as before", async () => {
		const dir = createTestDir();
		const tdd = writeSkill(dir, "tdd");
		const plan = await buildSkillLaunchPlanForTest("tdd, tdd", undefined, dir, dir);
		assert.deepEqual(plan.launchArgs, ["--no-skills", "--skill", tdd, "--skill", tdd]);
	});

	it("accepts identical duplicate annotations and rejects plain-plus-annotated conflicts", async () => {
		const dir = createTestDir();
		writeSkill(dir, "tdd");
		const plan = await buildSkillLaunchPlanForTest("tdd=auto, tdd=auto", undefined, dir, dir);
		assert.equal(plan.visibilitySpec, "tdd=auto,tdd=auto");
		await assert.rejects(
			() => buildSkillLaunchPlanForTest("tdd, tdd=auto", undefined, dir, dir),
			/Conflicting visibility annotations for skill "tdd"/,
		);
	});
});
