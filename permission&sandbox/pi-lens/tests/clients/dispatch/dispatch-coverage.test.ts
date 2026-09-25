/**
 * Dispatch-coverage guard (#209).
 *
 * Catches the "markdownlint class" of regression: a runner that is registered
 * (and installs/runs fine) but is wired into NO dispatch plan, so it silently
 * never runs on a file write. The live tool-smoke harness only shows such a tool
 * as an ambiguous "not executed"; this deterministic, per-PR test fails loudly
 * and names the dead runner. Also catches the inverse — a plan referencing a
 * runner id that no longer exists (a silent no-op).
 *
 * Source of truth: the registry (`registerDefaultRunners`) vs the static plans.
 * Reachability is the per-write plans (`TOOL_PLANS`). Runners reached only by a
 * dynamic, non-static path are listed in DYNAMIC_OR_EXEMPT with the reason.
 */

import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import type { FileKind } from "../../../clients/file-kinds.js";
import { TOOL_PLANS } from "../../../clients/dispatch/plan.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";

// Runners reachable by a path the static plans don't capture.
const DYNAMIC_OR_EXEMPT = new Set<string>([
	// Injected by withSpotbugsGroup when --lens-spotbugs + a Java build descriptor
	// + compiled .class dir are present — never in the static plan (#133).
	"spotbugs",
]);

const DYNAMIC_SCHEDULED_KINDS = new Map<string, readonly FileKind[]>([
	["spotbugs", ["java", "kotlin"]],
]);

function registeredRunnerIds(): string[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list().map((r) => r.id);
}

function plannedRunnerIds(): Set<string> {
	const ids = new Set<string>();
	for (const plan of Object.values(TOOL_PLANS)) {
		for (const group of plan.groups) {
			for (const id of group.runnerIds) ids.add(id);
		}
	}
	return ids;
}

function scheduledKindsByRunner(): Map<string, Set<FileKind>> {
	const scheduled = new Map<string, Set<FileKind>>();
	for (const [kind, plan] of Object.entries(TOOL_PLANS) as Array<
		[FileKind, (typeof TOOL_PLANS)[string]]
	>) {
		for (const group of plan.groups) {
			if (group.filterKinds && !group.filterKinds.includes(kind)) continue;
			for (const runnerId of group.runnerIds) {
				const kinds = scheduled.get(runnerId) ?? new Set<FileKind>();
				kinds.add(kind);
				scheduled.set(runnerId, kinds);
			}
		}
	}
	for (const [runnerId, kinds] of DYNAMIC_SCHEDULED_KINDS) {
		const served = scheduled.get(runnerId) ?? new Set<FileKind>();
		for (const kind of kinds) served.add(kind);
		scheduled.set(runnerId, served);
	}
	return scheduled;
}

describe("dispatch coverage", () => {
	it("every registered runner is reachable by some dispatch plan (no dead runners)", () => {
		const planned = plannedRunnerIds();
		const dead = registeredRunnerIds().filter(
			(id) => !planned.has(id) && !DYNAMIC_OR_EXEMPT.has(id),
		);
		expect(
			dead,
			`registered but wired into no dispatch plan (markdownlint-class regression): ${dead.join(", ")}`,
		).toEqual([]);
	});

	it("every runner id referenced by a plan is actually registered (no phantom runners)", () => {
		const registered = new Set(registeredRunnerIds());
		const phantom = [...plannedRunnerIds()].filter((id) => !registered.has(id));
		expect(
			phantom,
			`plan references unregistered runner id(s): ${phantom.join(", ")}`,
		).toEqual([]);
	});

	it("serves every kind declared by each registered runner", () => {
		const scheduled = scheduledKindsByRunner();
		const registry = new RunnerRegistry();
		registerDefaultRunners(registry);
		const missing = registry
			.list()
			.flatMap((runner) =>
				runner.appliesTo
					.filter((kind) => !scheduled.get(runner.id)?.has(kind))
					.map((kind) => `${runner.id}:${kind}`),
			);

		expect(
			missing,
			`runner appliesTo kinds missing from dispatch groups: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every dynamic/exempt runner is still registered", () => {
		const registered = new Set(registeredRunnerIds());
		const stale = [...DYNAMIC_OR_EXEMPT].filter((id) => !registered.has(id));
		// DYNAMIC_OR_EXEMPT may legitimately become empty as dispatch becomes
		// statically representable. Keep the stale-entry check below.
		expect(stale, "dynamic/exempt entries must name live runners").toEqual([]);
	});

	it("keeps dynamic scheduling declarations aligned with exemptions", () => {
		expect([...DYNAMIC_SCHEDULED_KINDS.keys()].sort()).toEqual(
			[...DYNAMIC_OR_EXEMPT].sort(),
		);
	});
});
