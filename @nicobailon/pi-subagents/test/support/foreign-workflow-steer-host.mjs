// Separate caller process: deliberately no local workflow/controller state.
import fs from "node:fs";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { makeMinimalCtx, createEventBus } from "./helpers.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { steerRequestsDir } from "../../src/runs/background/control-channel.ts";
const [cwd, sessionFile, paramsJson, output, policy = "auto"] = process.argv.slice(2);
const input = JSON.parse(paramsJson);
const requests = Array.isArray(input) ? input : [{ params: input, policy }];
const results = [];
for (const request of requests) {
	const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
	const executor = createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state, config: { authorityPolicy: { steerRun: request.policy ?? policy } }, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd, expandTilde: p => p, discoverAgents: () => ({ agents: [] }), kill: () => { throw new Error("foreign steering must not probe/kill an owner"); } });
	const ctx = makeMinimalCtx(cwd);
	ctx.sessionManager.getSessionFile = () => sessionFile;
	ctx.sessionManager.getSessionId = () => "different-runtime-id-in-caller";
	const result = await executor.execute("foreign-steer", { action: "steer", message: "B actual tool route", ...request.params }, new AbortController().signal, undefined, ctx);
	const requestDir = typeof request.params.dir === "string" ? steerRequestsDir(request.params.dir) : undefined;
	results.push({ pid: process.pid, sessionId: state.currentSessionId, completionOwnerId: currentCompletionOwnerId(), controllers: state.workflowControllers?.size ?? 0, controls: state.foregroundControls.size, requestCount: requestDir && fs.existsSync(requestDir) ? fs.readdirSync(requestDir).length : 0, result });
}
fs.writeFileSync(output, JSON.stringify(Array.isArray(input) ? results : results[0]));
