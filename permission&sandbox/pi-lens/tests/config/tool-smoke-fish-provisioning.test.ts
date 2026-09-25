import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { TOOLS } from "../../clients/installer/index.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/tool-smoke.yml";

type Step = { name?: unknown; run?: unknown };
type Workflow = { jobs?: Record<string, { steps?: unknown }> };

function readWorkflow(source = readFileSync(resolve(ROOT, WORKFLOW), "utf8")) {
	return { source, document: yaml.load(source) as Workflow };
}

function fishInstallStep(workflow: Workflow): Step {
	const steps = workflow.jobs?.["tool-smoke"]?.steps;
	if (!Array.isArray(steps))
		throw new Error(`${WORKFLOW} has no tool-smoke steps`);
	const step = (steps as Step[]).find((candidate) =>
		String(candidate.name).includes("Install fish for fish-lsp"),
	);
	if (!step) throw new Error(`${WORKFLOW} has no fish provisioning step`);
	return step;
}

function expectUnpinnedFish(run: string): void {
	expect(run).toContain("sudo apt-get install --yes fish\n");
	expect(run).not.toContain("fish=");
}

function expectSafeRunScalars(file: string, source: string): void {
	for (const [index, line] of source.split("\n").entries()) {
		const match = line.match(/^(\s*)(?:-\s+)?run:\s+(.+)$/);
		if (!match || /^[|>]/.test(match[2].trim())) continue;
		const scalar = match[2].trim();
		if (/\:\s/.test(scalar) || /\:\s*$/.test(scalar)) {
			expect(
				["'", '"'].includes(scalar[0]),
				`${file}:${index + 1} hazardous run scalar must be quoted: ${scalar}`,
			).toBe(true);
		}
	}
}

describe("tool-smoke fish provisioning policy (#3374)", () => {
	it("leaves distro provisioning unpinned while keeping fish-lsp as the tested tool", () => {
		const { document } = readWorkflow();
		const run = String(fishInstallStep(document).run);
		expectUnpinnedFish(run);

		const fishTool = TOOLS.find((tool) => tool.id === "fish-lsp");
		expect(fishTool).toMatchObject({
			installStrategy: "npm",
			packageName: "fish-lsp",
		});
	});

	it("requires quoting every single-line run scalar containing ': ' or ending in ':'", () => {
		const workflowFiles = readdirSync(resolve(ROOT, ".github/workflows"))
			.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
			.map((file) => `.github/workflows/${file}`);
		for (const file of workflowFiles) {
			const source = readFileSync(resolve(ROOT, file), "utf8");
			yaml.load(source);
			expectSafeRunScalars(file, source);
		}
	});

	it("scans inline run list items and exempts literal blocks (#3318)", () => {
		const inline = "jobs:\n  build:\n    steps:\n      - run: echo :all:\n";
		expect(() => expectSafeRunScalars("inline-fixture.yml", inline)).toThrow(
			"hazardous run scalar must be quoted",
		);

		const block =
			"jobs:\n  build:\n    steps:\n      - run: |\n          echo :all:\n";
		expect(() =>
			expectSafeRunScalars("block-fixture.yml", block),
		).not.toThrow();
	});

	it("mutation-proof: a pinned fish provisioning command reds the policy", () => {
		const { source } = readWorkflow();
		const mutated = source.replace(
			"sudo apt-get install --yes fish\n",
			"sudo apt-get install --yes fish=9.9.9-1",
		);
		expect(mutated).not.toBe(source);
		const run = String(fishInstallStep(readWorkflow(mutated).document).run);
		expect(() => expectUnpinnedFish(run)).toThrow();
	});
});
