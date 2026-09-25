import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { ExtensionContext, SessionStartEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

test("activates against the running Pi when a package-local pi-ai lacks transcript helpers", async () => {
	const hostRoot = resolveInstalledPiPackageRoot();
	assert.ok(hostRoot, "test needs a real Pi SDK root");
	const previousHost = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = hostRoot;
	delete process.env.PI_PACKAGE_DIR;

	// Simulate an older pi-ai installed beside this package, not the running host.
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@earendil-works/pi-ai" && context.parentURL &&
				new URL(context.parentURL).pathname.endsWith("/src/extension/tool-activation.ts")) {
				return { url: "data:text/javascript,export const legacy = true", shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	try {
		const { registerSubagentToolActivation } = await import("../../src/extension/tool-activation.ts");
		const handlers = new Map<string, (event: SessionStartEvent | SessionTreeEvent, ctx: ExtensionContext) => void>();
		const tools = new Set(["read", "subagent"]);
		let active = ["read", "subagent"];
		const pi = {
			getAllTools: () => [...tools].map((name) => ({ name })),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => { active = names; },
			registerTool: (tool: { name: string }) => { tools.add(tool.name); active.push(tool.name); },
			on: (event: string, handler: (event: SessionStartEvent | SessionTreeEvent, ctx: ExtensionContext) => void) => {
				handlers.set(event, handler);
				return () => {};
			},
		};
		// SAFETY: activation calls only the five Pi methods supplied by this fixture.
		registerSubagentToolActivation(pi as never, { advertisedPrompt: () => undefined });
		assert.ok(tools.has("subagents_enable"), "host API should enable the self-service loader");
		const onStart = handlers.get("session_start");
		const onTree = handlers.get("session_tree");
		assert.ok(onStart);
		assert.ok(onTree);
		const messages: Array<{ role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }> = [];
		// SAFETY: activation reads only sessionManager.buildSessionContext().messages.
		const context = {
			sessionManager: { buildSessionContext: () => ({ messages }) },
		} as never;
		onStart({ type: "session_start", reason: "startup" }, context);
		assert.equal(active.includes("subagent"), false, "fresh parent must not advertise delegation");
		assert.equal(active.includes("subagents_enable"), true);
		messages.push({ role: "system", toolsAdded: [{ name: "subagent" }] });
		onTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, context);
		assert.equal(active.includes("subagent"), true, "native selection must survive navigation");
		messages.push({ role: "system", toolsRemoved: [{ name: "subagent" }] });
		onTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, context);
		assert.equal(active.includes("subagent"), false, "native deselection must survive navigation");
	} finally {
		hook.deregister();
		if (previousHost === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousHost;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previousPackageDir;
	}
});
