import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { controlInboxDir, requestAsyncInterrupt, requestAsyncStop, requestAsyncTimeout } from "../../src/runs/background/control-channel.ts";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { createNestedRoute, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

function controlFiles(asyncDir: string): string[] {
	const inbox = controlInboxDir(asyncDir);
	if (!fs.existsSync(inbox)) return [];
	return fs.readdirSync(inbox, { recursive: true }).map(String).filter((name) => fs.statSync(path.join(inbox, name)).isFile());
}

function seedTree(route: ReturnType<typeof createNestedRoute>, dirs: Record<"A" | "A1" | "B" | "B1", string>): void {
	for (const [index, [id, parentRunId, depth]] of ([
		["A", "root", 1], ["A1", "A", 2], ["B", "root", 1], ["B1", "B", 2],
	] as const).entries()) {
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: Date.now() + index,
			parentRunId,
			parentStepIndex: 0,
			child: {
				id, parentRunId, parentStepIndex: 0, depth,
				path: parentRunId === "root" ? [{ runId: "root", stepIndex: 0 }] : [{ runId: "root", stepIndex: 0 }, { runId: parentRunId, stepIndex: 0 }],
				asyncDir: dirs[id], state: "running", ownerState: "live", agent: `${id}-agent`, startedAt: Date.now(), lastUpdate: Date.now(),
			},
		});
	}
}

describe("nested control runner fanout", () => {
	for (const action of ["stop", "interrupt", "timeout"] as const) {
		for (const issuer of ["A", "root"] as const) {
			it(`${action} from ${issuer} reaches only its descendant tree`, async () => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-nested-${issuer}-${action}-`));
				const route = createNestedRoute(`fanout-${issuer}-${action}-${process.pid}-${Date.now()}`);
				try {
					const queue = path.join(root, "queue");
					fs.mkdirSync(queue, { recursive: true });
					fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ hangUntilAbort: true, output: "held" }));
					const dirs = { A: path.join(root, "A"), A1: path.join(root, "A1"), B: path.join(root, "B"), B1: path.join(root, "B1") };
					for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
					seedTree(route, dirs);
					assert.equal(projectNestedEvents(route).children.length, 2, "fixture must contain independent A and B trees");
					const issuerDir = issuer === "A" ? dirs.A : path.join(root, "root");
					fs.mkdirSync(issuerDir, { recursive: true });
					const config: SubagentRunConfig = {
						id: issuer, steps: [{ agent: issuer, task: "hold" }], resultPath: path.join(issuerDir, "result.json"), cwd: root,
						placeholder: "{previous}", asyncDir: issuerDir, sessionId: `session-${issuer}-${action}`, artifactConfig: { enabled: false }, share: false, nestedRoute: route,
					};
					if (issuer === "A") config.nestedSelf = { parentRunId: "root", parentStepIndex: 0, depth: 1, path: [{ runId: "root", stepIndex: 0 }] };
					if (action === "stop") requestAsyncStop(issuerDir, { source: "test" });
					else if (action === "interrupt") requestAsyncInterrupt(issuerDir, { source: "test" });
					else requestAsyncTimeout(issuerDir, { source: "test" });

					await runSubagent(config, createFakeChildSessions(() => queue).factory);

					const touched = Object.fromEntries(Object.entries(dirs).map(([name, dir]) => [name, controlFiles(dir).length > 0]));
					assert.deepEqual(touched, issuer === "root"
						? { A: true, A1: true, B: true, B1: true }
						: { A: true, A1: true, B: false, B1: false });
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
					fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
				}
			});
		}
	}
});
