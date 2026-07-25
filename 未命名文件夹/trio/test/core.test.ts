import assert from "node:assert/strict";
import test from "node:test";
import {
	TRIO_STATE_ENTRY,
	getPhaseInstructions,
	getToolsForPhase,
	mergeTrioConfig,
	readLatestWorkflowState,
	TRANSITION_TOOLS,
	type TrioWorkflowState,
} from "../src/core.ts";

const ALL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"custom_tool",
	...Object.values(TRANSITION_TOOLS),
];

const ACTIVE_STATE: TrioWorkflowState = {
	version: 1,
	active: true,
	phase: "planning",
	task: "Implement the feature",
	reviewRound: 0,
	original: {
		model: { provider: "provider", model: "original" },
		thinkingLevel: "medium",
		tools: ["read", "bash", "edit", "write", "custom_tool"],
	},
};

const TEST_CONFIG = mergeTrioConfig(
	undefined,
	{
		planner: { provider: "provider", model: "planner" },
		executor: { provider: "provider", model: "executor" },
		reviewer: { provider: "provider", model: "reviewer" },
	},
	"test config",
);

test("requires all role models in a standalone configuration", () => {
	assert.throws(
		() => mergeTrioConfig(undefined, { planner: { provider: "provider", model: "planner" } }, "test config"),
		/executor.provider/,
	);
});

test("merges project role overrides over a complete global configuration", () => {
	const globalConfig = mergeTrioConfig(
		undefined,
		{
			planner: { provider: "provider", model: "planner" },
			executor: { provider: "provider", model: "executor" },
			reviewer: { provider: "provider", model: "reviewer" },
		},
		"global config",
	);
	const config = mergeTrioConfig(
		globalConfig,
		{ executor: { model: "other-executor", thinkingLevel: "off" }, maxReviewRounds: 4 },
		"project config",
	);

	assert.deepEqual(config.planner, globalConfig.planner);
	assert.deepEqual(config.reviewer, globalConfig.reviewer);
	assert.equal(config.executor.provider, "provider");
	assert.equal(config.executor.model, "other-executor");
	assert.equal(config.executor.thinkingLevel, "off");
	assert.equal(config.maxReviewRounds, 4);
});

test("keeps optional role settings and review caps absent until configured", () => {
	const config = mergeTrioConfig(
		undefined,
		{
			planner: { provider: "provider", model: "planner" },
			executor: { provider: "provider", model: "executor" },
			reviewer: { provider: "provider", model: "reviewer", thinkingLevel: "high" },
		},
		"test config",
	);

	assert.equal(config.planner.thinkingLevel, undefined);
	assert.equal(config.executor.thinkingLevel, undefined);
	assert.equal(config.reviewer.thinkingLevel, "high");
	assert.equal(config.maxReviewRounds, undefined);
});

test("rejects invalid configuration", () => {
	assert.throws(
		() => mergeTrioConfig(TEST_CONFIG, { planner: { thinkingLevel: "enormous" } }, "test config"),
		/thinkingLevel/,
	);
	assert.throws(() => mergeTrioConfig(TEST_CONFIG, { maxReviewRounds: -1 }, "test config"), /maxReviewRounds/);
});

test("keeps transition tools inactive while Trio is idle", () => {
	const tools = getToolsForPhase("idle", ACTIVE_STATE.original.tools, ALL_TOOLS);
	assert.deepEqual(tools, ACTIVE_STATE.original.tools);
	for (const transitionTool of Object.values(TRANSITION_TOOLS)) {
		assert.equal(tools.includes(transitionTool), false);
	}
});

test("activates only phase-appropriate transition tools", () => {
	const planning = getToolsForPhase("planning", ACTIVE_STATE.original.tools, ALL_TOOLS);
	assert.equal(planning.includes("edit"), false);
	assert.equal(planning.includes("write"), false);
	assert.equal(planning.includes(TRANSITION_TOOLS.delegate), true);
	assert.equal(planning.includes(TRANSITION_TOOLS.submit), false);

	const executing = getToolsForPhase("executing", ACTIVE_STATE.original.tools, ALL_TOOLS);
	assert.equal(executing.includes("edit"), true);
	assert.equal(executing.includes("write"), true);
	assert.equal(executing.includes(TRANSITION_TOOLS.submit), true);
	assert.equal(executing.includes(TRANSITION_TOOLS.delegate), false);

	const reviewing = getToolsForPhase("reviewing", ACTIVE_STATE.original.tools, ALL_TOOLS);
	assert.equal(reviewing.includes("edit"), false);
	assert.equal(reviewing.includes("write"), false);
	assert.equal(reviewing.includes(TRANSITION_TOOLS.revise), true);
	assert.equal(reviewing.includes(TRANSITION_TOOLS.approve), true);
	assert.equal(reviewing.includes(TRANSITION_TOOLS.submit), false);

	const finalizing = getToolsForPhase("finalizing", ACTIVE_STATE.original.tools, ALL_TOOLS);
	for (const transitionTool of Object.values(TRANSITION_TOOLS)) {
		assert.equal(finalizing.includes(transitionTool), false);
	}
});

test("builds phase-specific instructions from shared workflow state", () => {
	const planning = getPhaseInstructions(ACTIVE_STATE, TEST_CONFIG);
	assert.match(planning ?? "", /TRIO PHASE: PLANNING/);
	assert.match(planning ?? "", new RegExp(TRANSITION_TOOLS.delegate));
	assert.match(planning ?? "", /Implement the feature/);

	const executing = getPhaseInstructions({ ...ACTIVE_STATE, phase: "executing" }, TEST_CONFIG);
	assert.match(executing ?? "", /TRIO PHASE: EXECUTION/);
	assert.match(executing ?? "", new RegExp(TRANSITION_TOOLS.submit));

	const reviewing = getPhaseInstructions(
		{ ...ACTIVE_STATE, phase: "reviewing" },
		{
			...TEST_CONFIG,
			reviewer: { ...TEST_CONFIG.reviewer, systemPrompt: "Focus on security and regressions." },
		},
	);
	assert.match(reviewing ?? "", /You are the reviewer/);
	assert.match(reviewing ?? "", /REVIEW — round 0\]/);
	assert.doesNotMatch(reviewing ?? "", /working.tree/i);
	assert.match(reviewing ?? "", /TRIO ROLE SYSTEM PROMPT/);
	assert.match(reviewing ?? "", /Focus on security and regressions/);

	assert.equal(getPhaseInstructions({ ...ACTIVE_STATE, active: false, phase: "idle" }, TEST_CONFIG), undefined);
});

test("restores the latest valid workflow state from the active branch", () => {
	const latest = { ...ACTIVE_STATE, phase: "reviewing" as const, reviewRound: 1 };
	const restored = readLatestWorkflowState([
		{ type: "custom", customType: TRIO_STATE_ENTRY, data: ACTIVE_STATE },
		{ type: "custom", customType: TRIO_STATE_ENTRY, data: { invalid: true } },
		{ type: "custom", customType: TRIO_STATE_ENTRY, data: latest },
	]);

	assert.deepEqual(restored, latest);
});
