import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildBuiltinOverrideConfig,
	discoverAgents,
	discoverAgentsAll,
} from "../../src/agents/agents.ts";
import { handleUpdate } from "../../src/agents/agent-management.ts";
import { resolvePiLaunchToolPlan } from "../../src/api/child-tool-plan.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(name: string, extensionFrontmatter = ""): void {
	const filePath = path.join(tempProject, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: Test agent${extensionFrontmatter ? `\n${extensionFrontmatter}` : ""}\n---\n\nTest agent.\n`,
		"utf-8",
	);
}

describe("subagent extension defaults", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagents-project-"),
		);
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("preserves ambient discovery when omitted and disables it when empty", () => {
		let scout = discoverAgentsAll(tempProject).builtin.find(
			(agent) => agent.name === "scout",
		);
		assert.equal(scout?.extensions, undefined);
		assert.equal(scout?.subagentOnlyExtensions, undefined);

		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultExtensions: [] },
		});
		scout = discoverAgentsAll(tempProject).builtin.find(
			(agent) => agent.name === "scout",
		);
		assert.deepEqual(scout?.extensions, []);
	});

	it("preserves ambient loading unless extensions defaults are also configured", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultSubagentOnlyExtensions: ["  ./child.ts  "] },
		});
		const scout = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.equal(scout.extensions, undefined);
		assert.deepEqual(scout.subagentOnlyExtensions, ["./child.ts"]);

		const plan = resolvePiLaunchToolPlan(scout);
		assert.equal(plan.disableAmbientExtensions, false);
		assert.ok(plan.extensionArgs.includes("./child.ts"));

		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultExtensions: ["./allowlisted.ts"],
				defaultSubagentOnlyExtensions: ["./child.ts"],
			},
		});
		const allowlisted = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "scout");
		assert.ok(allowlisted);
		const allowlistedPlan = resolvePiLaunchToolPlan(allowlisted);
		assert.equal(allowlistedPlan.disableAmbientExtensions, true);
		assert.ok(allowlistedPlan.extensionArgs.includes("./allowlisted.ts"));
		assert.ok(allowlistedPlan.extensionArgs.includes("./child.ts"));
	});

	it("preserves an explicit child-only field and applies overrides after defaults", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultSubagentOnlyExtensions: ["./default.ts"],
				agentOverrides: {
					replaced: { subagentOnlyExtensions: ["./user-replacement.ts"] },
					cleared: { subagentOnlyExtensions: ["./user-cleared.ts"] },
					scout: { subagentOnlyExtensions: [] },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					replaced: { subagentOnlyExtensions: ["./replacement.ts"] },
					cleared: { subagentOnlyExtensions: false },
				},
			},
		});
		writeProjectAgent("empty", "subagentOnlyExtensions:");
		writeProjectAgent("explicit", "subagentOnlyExtensions: ./explicit.ts");
		writeProjectAgent("replaced");
		writeProjectAgent("cleared");

		const agents = discoverAgents(tempProject, "both").agents;
		assert.deepEqual(agents.find((agent) => agent.name === "empty")?.subagentOnlyExtensions, []);
		assert.deepEqual(agents.find((agent) => agent.name === "explicit")?.subagentOnlyExtensions, [path.join(tempProject, ".pi", "agents", "explicit.ts")]);
		assert.deepEqual(agents.find((agent) => agent.name === "replaced")?.subagentOnlyExtensions, ["./replacement.ts"]);
		assert.equal(agents.find((agent) => agent.name === "cleared")?.subagentOnlyExtensions, undefined);
		assert.deepEqual(agents.find((agent) => agent.name === "scout")?.subagentOnlyExtensions, []);
	});

	it("applies the allowlist only when an agent has no extensions field", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultExtensions: ["./shared.ts"] },
		});
		writeProjectAgent("inherited");
		writeProjectAgent("explicit", "extensions: ./explicit.ts");
		writeProjectAgent("disabled", "extensions:");

		const agents = discoverAgents(tempProject, "both").agents;
		assert.deepEqual(
			agents.find((agent) => agent.name === "inherited")?.extensions,
			["./shared.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "explicit")?.extensions,
			[path.join(tempProject, ".pi", "agents", "explicit.ts")],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "disabled")?.extensions,
			[],
		);
	});

	it("supports per-agent extensions through agentOverrides", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultExtensions: [],
				agentOverrides: {
					scout: { extensions: ["./scout.ts"] },
					inherited: { extensions: ["./inherited.ts"] },
					explicit: { extensions: ["./ignored.ts"] },
				},
			},
		});
		writeProjectAgent("inherited");
		writeProjectAgent("explicit", "extensions: ./frontmatter.ts");

		const agents = discoverAgents(tempProject, "both").agents;
		assert.deepEqual(
			agents.find((agent) => agent.name === "scout")?.extensions,
			["./scout.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "inherited")?.extensions,
			["./inherited.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "explicit")?.extensions,
			["./ignored.ts"],
		);
	});

	it("does not serialize settings-derived extensions during unrelated updates", () => {
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				defaultExtensions: ["./default.ts"],
				defaultSubagentOnlyExtensions: ["./child-default.ts"],
				agentOverrides: {
					overridden: { extensions: ["./override.ts"] },
				},
			},
		});
		writeProjectAgent("defaulted");
		writeProjectAgent("overridden");
		writeProjectAgent("declared", "subagentOnlyExtensions: ./declared.ts");
		const discovered = new Map(discoverAgents(tempProject, "both").agents.map((agent) => [agent.name, agent]));
		for (const name of ["defaulted", "overridden"]) assert.deepEqual(discovered.get(name)?.subagentOnlyExtensions, ["./child-default.ts"]);
		assert.deepEqual(discovered.get("declared")?.subagentOnlyExtensions, [path.join(tempProject, ".pi", "agents", "declared.ts")]);

		const ctx = {
			cwd: tempProject,
			modelRegistry: { getAvailable: () => [] },
		} as unknown as Parameters<typeof handleUpdate>[1];
		for (const agent of ["defaulted", "overridden", "declared"]) {
			const updated = handleUpdate(
				{ agent, config: { description: `Updated ${agent}` } },
				ctx,
			);
			assert.equal(
				(updated as typeof updated & { isError?: boolean }).isError,
				false,
			);
			const content = fs.readFileSync(
				path.join(tempProject, ".pi", "agents", `${agent}.md`),
				"utf-8",
			);
			assert.doesNotMatch(content, /^extensions:/m);
			if (agent === "declared") assert.match(content, /^subagentOnlyExtensions: \.\/declared\.ts$/m);
			else assert.doesNotMatch(content, /^subagentOnlyExtensions:/m);
		}
	});

	it("persists per-agent extension overrides", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				systemPrompt: "Test agent",
				extensions: [],
			},
			{
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				systemPrompt: "Test agent",
				extensions: ["./agent.ts"],
			},
		);

		assert.deepEqual(override, { extensions: ["./agent.ts"] });
	});

	it("uses project settings over user settings while respecting discovery scope", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultExtensions: ["./user.ts"],
				defaultSubagentOnlyExtensions: ["./user-child.ts"],
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultExtensions: [] },
		});

		const both = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "scout");
		const user = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "scout");
		const project = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "scout");
		assert.deepEqual(both?.extensions, []);
		assert.deepEqual(both?.subagentOnlyExtensions, ["./user-child.ts"]);
		assert.deepEqual(user?.extensions, ["./user.ts"]);
		assert.deepEqual(user?.subagentOnlyExtensions, ["./user-child.ts"]);
		assert.deepEqual(project?.extensions, []);
		assert.equal(project?.subagentOnlyExtensions, undefined);

		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultExtensions: [], defaultSubagentOnlyExtensions: [] },
		});
		assert.deepEqual(
			discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "scout")?.subagentOnlyExtensions,
			[],
		);
	});

	it("rejects malformed values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const settingName of ["defaultExtensions", "defaultSubagentOnlyExtensions"]) {
			for (const value of ["nope", ["   "], [42], ["valid", 42]]) {
				writeJson(settingsPath, { subagents: { [settingName]: value } });
				assert.throws(
					() => discoverAgents(tempProject, "both"),
					(error: unknown) =>
						error instanceof Error &&
						error.message.includes(settingsPath) &&
						error.message.includes(settingName),
				);
			}
		}
	});
});
