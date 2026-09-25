import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asyncResultTimeoutEvidence } from "../support/async-result-timeout-evidence.ts";

it("correlates timeout evidence without promoting pending sidecars or exposing contents", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-evidence-"));
	try {
		const proof = { runId: "run", runnerProcessInstanceId: "private-runner", state: "pending" };
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: "run", state: "running", pid: 123, processTerminal: proof, steps: [{ status: "complete" }, { status: "complete" }], task: "SECRET" }));
		fs.writeFileSync(path.join(dir, "process-terminal.json"), JSON.stringify(proof));
		fs.writeFileSync(path.join(dir, "process-terminal-candidate.json"), JSON.stringify({ ...proof, writers: {}, expectedWriters: { "0": 0, "1": 0 } }));
		fs.writeFileSync(path.join(dir, "events.jsonl"), [
			{ type: "subagent.step.completed", runId: "run", stepIndex: 1, ts: 42, output: "SECRET" },
			{ type: "subagent.parallel.completed", runId: "run", stepIndex: 0, ts: 43 },
			{ type: "subagent.run.completed", runId: "other", ts: 43 },
		].map((event) => JSON.stringify(event)).join("\n"));
		fs.writeFileSync(path.join(dir, "runner.stderr.log"), "SECRET");
		const evidence = asyncResultTimeoutEvidence(dir, "run").join("\n");
		assert.match(evidence, /"state":"pending"/);
		assert.match(evidence, /"runnerIdMatches":true/);
		assert.match(evidence, /"mismatchedRunEvents":1/);
		assert.match(evidence, /"stepIndex":1/);
		assert.match(evidence, /subagent.parallel.completed/);
		assert.match(evidence, /runner-startup-proceed.json: ENOENT/);
		assert.doesNotMatch(evidence, /SECRET|private-runner|subagent.run.completed/);
		fs.writeFileSync(path.join(dir, "process-terminal.json"), JSON.stringify({ ...proof, state: "observed", runnerProcessInstanceId: "other", instances: [{ kind: "runner", processInstanceId: "other", closeObservedAt: 99, exitCode: 1, signal: null }] }));
		const mismatch = asyncResultTimeoutEvidence(dir, "run").join("\n");
		assert.match(mismatch, /"runnerIdMatches":false/);
		assert.match(mismatch, /"closeObservedAt":99,"exitCode":1,"signal":null/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("bounds timeout reads and output, and tolerates missing, malformed and oversized evidence", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-evidence-"));
	try {
		fs.writeFileSync(path.join(dir, "status.json"), "x".repeat(20_000));
		fs.writeFileSync(path.join(dir, "process-terminal.json"), "{");
		fs.writeFileSync(path.join(dir, "process-terminal-candidate.json"), JSON.stringify({ runId: "run", runnerProcessInstanceId: "private-runner" }));
		fs.writeFileSync(path.join(dir, "runner.stdout.log"), "SECRET".repeat(100_000));
		fs.writeFileSync(path.join(dir, "events.jsonl"), "SECRET".repeat(3_000) + "\n" + Array.from({ length: 100 }, () => JSON.stringify({ type: "subagent.run.completed", runId: "run", ts: 42 })).join("\n"));
		const evidence = asyncResultTimeoutEvidence(dir, "run").join("\n");
		assert.match(evidence, /oversize/);
		assert.match(evidence, /invalid JSON/);
		assert.match(evidence, /"tailOnly":true/);
		assert.match(evidence, /"runnerIdMatches":"unavailable"/);
		assert.equal(evidence.match(/subagent.run.completed/g)?.length, 16);
		assert.ok(Buffer.byteLength(evidence) < 8_192);
		assert.doesNotMatch(evidence, /SECRET/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
