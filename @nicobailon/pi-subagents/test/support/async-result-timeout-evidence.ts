import * as fs from "node:fs";
import * as path from "node:path";

// Failure-only observations, not terminality predicates. Never expose free-form fields.
export function asyncResultTimeoutEvidence(asyncDir: string, id: string): string[] {
	const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const known = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value) ? value : "other/absent";
	const states = ["pending", "queued", "running", "complete", "completed", "failed", "cancelled", "paused", "stopped", "partial", "rejected", "observed", "unknown", "not-started"];
	let runnerId: string | undefined;
	const identity = (raw: Record<string, unknown>) => ({
		runIdMatches: raw.runId === id,
		runnerIdMatches: runnerId === undefined ? "unavailable" : raw.runnerProcessInstanceId === runnerId,
	});
	const proof = (raw: Record<string, unknown>) => ({
		...identity(raw), state: known(raw.state, states), observedAt: number(raw.observedAt),
		reason: known(raw.reason, ["observer-unavailable", "runner-candidate-missing", "runner-instance-mismatch", "writer-close-unverified", "process-tree-unverified", "canonical-session-unavailable", "canonical-session-lease-active", "canonical-session-release-unverified", "proof-write-failed", "stale-repair"]),
		runner: Array.isArray(raw.instances) ? raw.instances.slice(0, 16).map(record).filter((entry) => entry.kind === "runner").map((entry) => ({
			instanceMatches: runnerId === undefined ? "unavailable" : entry.processInstanceId === runnerId, closeObservedAt: number(entry.closeObservedAt),
			exitCode: entry.exitCode === null ? null : number(entry.exitCode), signal: entry.signal === null ? null : known(entry.signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]),
		})) : undefined,
	});
	return ["status.json", "runner-startup-proceed.json", "process-terminal.json", "process-terminal-candidate.json", "events.jsonl", "runner.stdout.log", "runner.stderr.log"].map((name) => {
		let fd: number | undefined;
		try {
			fd = fs.openSync(path.join(asyncDir, name), "r");
			const bytes = fs.fstatSync(fd).size;
			const base = { bytes, readAt: Date.now() };
			if (!bytes || name.endsWith(".log") || name === "runner-startup-proceed.json") return `${name}: ${JSON.stringify(base)} (contents withheld)`;
			const limit = 16_384;
			const offset = name === "events.jsonl" ? Math.max(0, bytes - limit) : 0;
			if (bytes > limit && name !== "events.jsonl") return `${name}: ${JSON.stringify(base)} (oversize, contents withheld)`;
			const buffer = Buffer.alloc(Math.min(bytes, limit));
			const text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, offset)).toString("utf-8");
			if (name === "events.jsonl") {
				let invalidLines = 0;
				let mismatchedRunEvents = 0;
				const events = [];
				for (const line of text.split("\n").slice(offset ? 1 : 0).filter(Boolean)) {
					try {
						const raw = record(JSON.parse(line));
						if (typeof raw.type !== "string" || !["subagent.run.started", "subagent.step.completed", "subagent.step.failed", "subagent.parallel.completed", "subagent.run.completed", "subagent.run.process_terminal"].includes(raw.type)) continue;
						if (raw.runId !== id) { mismatchedRunEvents++; continue; }
						events.push({ type: raw.type, ts: number(raw.ts), stepIndex: number(raw.stepIndex), pid: number(raw.pid), status: known(raw.status, states), exitCode: number(raw.exitCode), ...(raw.processTerminal ? { proof: proof(record(raw.processTerminal)) } : {}) });
					} catch { invalidLines++; }
				}
				return `${name}: ${JSON.stringify({ ...base, tailOnly: offset > 0, invalidLines, mismatchedRunEvents, events: events.slice(-16) })}`;
			}
			const raw = record(JSON.parse(text));
			if (name === "status.json") {
				const terminal = record(raw.processTerminal);
				if (raw.runId === id && terminal.runId === id && typeof terminal.runnerProcessInstanceId === "string") runnerId = terminal.runnerProcessInstanceId;
				return `${name}: ${JSON.stringify({ ...base, runIdMatches: raw.runId === id, pid: number(raw.pid), state: known(raw.state, states), lastUpdate: number(raw.lastUpdate), endedAt: number(raw.endedAt), steps: Array.isArray(raw.steps) ? raw.steps.slice(0, 16).map((step) => known(record(step).status, states)) : undefined, proof: proof(terminal) })}`;
			}
			if (name === "process-terminal-candidate.json") return `${name}: ${JSON.stringify({ ...base, ...identity(raw), writers: ["0", "1"].map((index) => ({ index, count: Array.isArray(record(raw.writers)[index]) ? (record(raw.writers)[index] as unknown[]).length : undefined, expected: number(record(raw.expectedWriters)[index]) })) })}`;
			return `${name}: ${JSON.stringify({ ...base, ...proof(raw) })}`;
		} catch (error) {
			return `${name}: ${error instanceof SyntaxError ? "invalid JSON" : known(record(error).code, ["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOSPC"])}`;
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	});
}
