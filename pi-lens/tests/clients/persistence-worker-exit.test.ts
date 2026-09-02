import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHILD_FIXTURE = fileURLToPath(
	new URL("../fixtures/persistence-worker-exit-child.mjs", import.meta.url),
);
const CHILD_EXIT_TIMEOUT_MS = 5_000;

type PersistenceKind = "project-snapshot" | "review-graph";

// A real OS child is load-bearing here: fake timers and an in-process test
// cannot detect that a Worker's referenced MessagePort prevents natural exit.
//
// Pre-fix (#1148): the worker's MessagePort was re-ref'd by the "message"
// listener added AFTER worker.unref(), so the child never exited on its own
// once persistence completed. Against unmodified code, this test's child
// hangs past CHILD_EXIT_TIMEOUT_MS below, gets SIGKILLed, and fails.
async function runPersistenceChild(kind: PersistenceKind): Promise<string> {
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-${kind}-exit-`),
	);
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD_FIXTURE, kind, tempRoot], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CHILD_EXIT_TIMEOUT_MS);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fs.rmSync(tempRoot, { recursive: true, force: true });
			if (error) reject(error);
			else resolve(stdout);
		};
		child.once("error", (error) => finish(error));
		child.once("close", (code, signal) => {
			if (timedOut) {
				finish(
					new Error(
						`${kind} child persisted its data but did not exit within ${CHILD_EXIT_TIMEOUT_MS}ms\n` +
							`stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
					),
				);
				return;
			}
			if (code !== 0) {
				finish(
					new Error(
						`${kind} child exited with code ${code} (signal ${signal ?? "none"})\n` +
							`stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
					),
				);
				return;
			}
			if (kind === "project-snapshot") {
				const pathLine = stdout
					.split(/\r?\n/)
					.find((line) => line.startsWith("snapshot-path:"));
				const snapshotPath = pathLine?.slice("snapshot-path:".length);
				try {
					if (!snapshotPath) throw new Error("child omitted snapshot path");
					const body = JSON.parse(
						gunzipSync(fs.readFileSync(snapshotPath)).toString("utf8"),
					) as { cachedExports?: unknown };
					if (
						!Array.isArray(body.cachedExports) ||
						body.cachedExports[0]?.[0] !== "latest"
					) {
						throw new Error(
							"exit flush did not persist latest queued snapshot",
						);
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
					return;
				}
			}
			finish();
		});
	});
}

describe("persistence worker process lifecycle (#1148)", () => {
	it(
		"project-snapshot persistence does not retain a completed child process",
		{ timeout: 10_000 },
		async () => {
			await expect(runPersistenceChild("project-snapshot")).resolves.toContain(
				"persisted:project-snapshot",
			);
		},
	);

	it(
		"review-graph persistence does not retain a completed child process",
		{ timeout: 10_000 },
		async () => {
			await expect(runPersistenceChild("review-graph")).resolves.toContain(
				"persisted:review-graph",
			);
		},
	);
});
