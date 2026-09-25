import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { METADATA_FILENAME } from "../../scripts/test-history-rollup.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as Record<
		string,
		unknown
	>;

function steps(workflow: string, job: string) {
	const jobs = load(workflow).jobs as Record<string, unknown>;
	const target = jobs[job] as Record<string, unknown>;
	if (!target) throw new Error(`${workflow} has no ${job} job`);
	return target.steps as Array<Record<string, unknown>>;
}

function step(workflow: string, job: string, name: string) {
	const found = steps(workflow, job).find((entry) => entry.name === name);
	if (!found) throw new Error(`${workflow}#${job} has no "${name}" step`);
	return found;
}

describe("#3215 durable test-history workflow contract", () => {
	it("pins the reporter flags and the Linux artifact", () => {
		const command = String(
			step(".github/workflows/ci.yml", "test", "Run tests").run,
		);
		expect(command).toContain("--reporter=default");
		expect(command).toContain("--reporter=json");
		expect(command).toContain("--outputFile=");
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const uploadWith = upload.with as Record<string, unknown>;
		expect(uploadWith.name).toBe("unit-test-results-linux");
		expect(upload.if).toBe("always()");
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		const metadataEnv = metadata.env as Record<string, unknown>;
		expect(metadataEnv.HEAD_SHA).toContain(
			"github.event.pull_request.head.sha",
		);
	});

	// Round 3 F8: the producer wrote and uploaded `test-history-metadata.json`
	// while `scripts/test-history-rollup.mjs` looked for a sibling
	// `metadata.json`, so the nightly rollup exited 2 on every real artifact and
	// lane 1 never wrote a row. The consumer's own exported constant is the one
	// source of truth, and both producer steps are asserted against it here —
	// not against a second copy of the string.
	it("writes and uploads exactly the basename the rollup consumer reads", () => {
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		expect(String(metadata.run)).toContain(`/${METADATA_FILENAME}`);
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const paths = String((upload.with as Record<string, unknown>).path)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		expect(paths.map((entry) => path.posix.basename(entry))).toEqual([
			"vitest-results.json",
			METADATA_FILENAME,
		]);
	});

	// The additive `JSON report written to ...` line is CI-only: the local
	// `npm test` script must add no JSON reporter, so a developer's console
	// stream is untouched. The line's exact text and cardinality are pinned by
	// driving the real vitest JsonReporter in
	// `tests/scripts/test-history-rollup.test.ts`.
	it("keeps the JSON reporter out of the local npm test script", () => {
		const { scripts } = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(scripts.test).not.toContain("--reporter=json");
		expect(scripts.test).not.toContain("--outputFile");
	});

	it("runs rollup only from the scheduled nightly and grants data-branch write access", () => {
		const workflow = load(".github/workflows/tool-smoke.yml");
		const jobs = workflow.jobs as Record<string, unknown>;
		const rollup = jobs["test-history-rollup"] as Record<string, unknown>;
		expect(rollup.if).toBe("github.event_name == 'schedule'");
		const permissions = rollup.permissions as Record<string, unknown>;
		expect(permissions.contents).toBe("write");
	});
});
