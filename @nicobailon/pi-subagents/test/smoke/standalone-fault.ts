import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Bun's named fs binding requires mock.module; fault only atomic rename after real spawn.
export default function injectStartupFailure(pi: ExtensionAPI) {
	const mode = process.env.PI_STANDALONE_SMOKE_MODE;
	if (!["persistence-failure", "authorization-failure", "revival"].includes(mode ?? "")) throw new Error("unsupported startup hook mode");
	pi.on("session_start", () => {
		const originalRename = fs.renameSync;
		let injected = false;
		const hook: typeof fs.renameSync = (from, to) => {
			const target = String(to);
			const asyncDir = path.dirname(target);
			if (mode === "revival" && /\/runner-startup-(?:ack|confirm|proceed)\.json$/.test(target) && fs.existsSync(path.join(asyncDir, "runner-startup.json"))) {
				const control = JSON.parse(fs.readFileSync(from, "utf8"));
				const startup = JSON.parse(fs.readFileSync(path.join(asyncDir, "runner-startup.json"), "utf8"));
				const events = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
				const record = { runId: path.basename(asyncDir), action: control.action, stateBefore: startup.state, tokenMatches: control.token === startup.token, childStartedBeforeCommit: events.some((event) => event.event === "start" && event.pid === startup.pid) };
				originalRename(from, to);
				fs.appendFileSync("/stage/handshake.jsonl", JSON.stringify(record) + "\n");
				return;
			}
			if (mode !== "revival" && !injected && target.includes("/async-subagent-runs/") && target.endsWith(mode === "persistence-failure" ? "/status.json" : "/runner-startup-proceed.json")) {
				const status = JSON.parse(fs.readFileSync(mode === "persistence-failure" ? from : path.join(asyncDir, "status.json"), "utf8"));
				if (typeof status.pid === "number") {
					assert.notEqual(status.pid, process.pid);
					process.kill(status.pid, 0);
					injected = true;
					fs.renameSync = originalRename;
					fs.writeFileSync("/stage/failure-injected.json", JSON.stringify({ asyncDir, pid: status.pid, target, mode }));
					throw new Error(`fixture ${mode} after real spawn`);
				}
			}
			return originalRename(from, to);
		};
		fs.renameSync = hook;
		mock.module("node:fs", () => ({ ...fs, default: fs, renameSync: hook }));
		fs.writeFileSync("/stage/startup-hook-ready.json", JSON.stringify({ mode, pid: process.pid }));
	});
}
