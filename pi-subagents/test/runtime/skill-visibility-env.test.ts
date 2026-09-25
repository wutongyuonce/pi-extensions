import { writeFileSync } from "node:fs";

import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	afterEach,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

async function readNonEmptyFileEventually(path: string): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (lastText.trim().length > 0) return lastText;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function writeCapturePi(dir: string, envLog: string): string {
	return writeExecutable(
		dir,
		"capture-pi",
		`#!/usr/bin/env bash\nprintf 'V=%s' "\${PI_SUBAGENT_SKILL_VISIBILITY-UNSET}" > '${envLog}'\ncat > /dev/null\n`,
	);
}

async function resumeAndCapture(dir: string, skills: string | undefined): Promise<string> {
	const envLog = join(dir, `env-${Math.random().toString(36).slice(2)}.log`);
	const bin = writeCapturePi(dir, envLog);
	const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	try {
		const sessionFile = join(dir, `child-${Math.random().toString(36).slice(2)}.jsonl`);
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "visibility-child",
			agent: "scout",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
			...(skills ? { skills } : {}),
		});
		await resumeSubagentSession(
			{ sessionFile, task: "Visibility env probe." },
			{
				isMuxAvailable: () => true,
				getShellReadyDelayMs: () => 0,
				watchBackgroundSubagent: async () => ({
					name: "",
					task: "",
					summary: "",
					exitCode: 0,
					elapsed: 0,
				}),
				watchSubagent: async () => ({
					name: "",
					task: "",
					summary: "",
					exitCode: 0,
					elapsed: 0,
				}),
				getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
				startWidgetRefresh: () => {},
				getContextWindow: () => undefined,
				runningSubagents: new Map<string, any>(),
			},
		);
		return (await readNonEmptyFileEventually(envLog)).trim();
	} finally {
		if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
	}
}

describe("skill visibility env on resume and timeout wrap-up", () => {
	const savedVisibility = process.env.PI_SUBAGENT_SKILL_VISIBILITY;
	const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;
	afterEach(() => {
		if (savedVisibility === undefined) delete process.env.PI_SUBAGENT_SKILL_VISIBILITY;
		else process.env.PI_SUBAGENT_SKILL_VISIBILITY = savedVisibility;
		if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
	});

	it("resumes with the persisted annotation spec in the child env", async () => {
		const dir = createTestDir();
		assert.equal(await resumeAndCapture(dir, "context7=auto, tdd"), "V=context7=auto");
	});

	it("clears an inherited visibility value when the persisted skills have no annotations", async () => {
		const dir = createTestDir();
		process.env.PI_SUBAGENT_SKILL_VISIBILITY = "context7=auto";
		assert.match(await resumeAndCapture(dir, "tdd"), /^V=(|UNSET)$/);
	});

	it("restarts timeout wrap-up with the original annotation spec, and clears it without one", async () => {
		const dir = createTestDir();
		for (const skills of ["context7=auto, tdd", "tdd"]) {
			const envLog = join(dir, `wrapup-${Math.random().toString(36).slice(2)}.log`);
			process.env.PI_SUBAGENT_PI_COMMAND = writeCapturePi(dir, envLog);
			process.env.PI_SUBAGENT_SKILL_VISIBILITY = skills === "tdd" ? "context7=auto" : "";
			const metadata: PersistedSubagentLaunchMetadata = {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "wrapup-child",
				agent: "scout",
				mode: "background",
				sessionMode: "fork",
				autoExit: false,
				parentClosePolicy: "terminate",
				async: true,
				modelRef: "test/model:off",
				denyTools: [],
				spawnBudget: 2,
				spawnableAgents: true,
				noContextFiles: false,
				noSession: true,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: true,
				timeout: 10,
				timeoutWarnThreshold: "80%",
				skills,
			};
			const sessionFile = join(dir, `wrapup-${Math.random().toString(36).slice(2)}.jsonl`);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);
			const running: RunningSubagent = {
				id: "wrapup-child",
				name: "wrapup-child",
				task: "Do the long task",
				agent: "scout",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				async: true,
				autoExit: false,
				noSession: true,
				startTime: Date.now() - 8_000,
				sessionFile,
				timeoutBudget: { timeoutSeconds: 10 },
				timeoutWarnThreshold: 80,
				timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
				modelRef: "test/model:off",
				launchMetadata: metadata,
			};
			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
			assert.ok(running.childProcess);
			await new Promise((resolve) => running.childProcess!.once("exit", resolve));
			assert.match(
				(await readNonEmptyFileEventually(envLog)).trim(),
				skills === "tdd" ? /^V=(|UNSET)$/ : /^V=context7=auto$/,
			);
		}
	});
});
