/**
 * Standalone review-graph builder. Spawns the in-place compiled CLI, so run
 * `npm run build` before this test.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const binJs = path.join(repoRoot, "mcp", "cli.js");

function runCli(
	args: string[],
	dataDir: string,
	extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [binJs, ...args], {
			env: {
				...process.env,
				PILENS_DATA_DIR: dataDir,
				PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS: "60000",
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

let tempRoot: string;
let projectDir: string;
let dataDir: string;

beforeAll(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-build-graph-cli-"));
	projectDir = path.join(tempRoot, "project");
	dataDir = path.join(tempRoot, "data");
	fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, "src", "a.ts"),
		"export const answer = 42;\n",
	);
	fs.writeFileSync(
		path.join(projectDir, "src", "b.ts"),
		'import { answer } from "./a.js";\nexport const doubled = answer * 2;\n',
	);
});

afterAll(() => removeTempDirSync(tempRoot));

describe("pi-lens build-graph CLI", () => {
	it("builds and persists a small project with a stats line", async () => {
		const result = await runCli(["build-graph", "--cwd", projectDir], dataDir);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(
			/^pi-lens build-graph: files=\d+ nodes=\d+ edges=\d+ elements=\d+ jsonBytes=\d+ durationMs=\d+$/,
		);
		const snapshots = fs
			.readdirSync(dataDir, { recursive: true })
			.filter((entry) => String(entry).endsWith("review-graph.json.gz"));
		expect(snapshots).toHaveLength(1);
	});

	it("re-run on an unchanged project reports snapshot-current and exits 0", async () => {
		// #943 review blocker: the disk-cache hit queues no persist, and the
		// old CLI treated the empty flush as failure — a nightly cron on a
		// quiet repo failed every run after the first.
		const first = await runCli(["build-graph", "--cwd", projectDir], dataDir);
		expect(first.code).toBe(0);
		const second = await runCli(["build-graph", "--cwd", projectDir], dataDir);
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("snapshot already current");
	}, 30000);

	it("fails loudly for an unsafe home root", async () => {
		const result = await runCli(
			["build-graph", `--cwd=${os.homedir()}`],
			dataDir,
		);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("pi-lens build-graph failed: unsafe_root");
	});

	// #936 limit 3 review: an over-cap out-of-band build must still exit 0 and
	// persist a useful subgraph (#960's partial-persist circuit-breaker fix) —
	// but the CLI must say PARTIAL, not print the same "done" line a full
	// build would (#533 honesty). A prior version of this CLI mistook the
	// benign "succeeded, but persisted partial" build-attempt reason for a
	// hard failure and exited non-zero here.
	it("persists a PARTIAL subgraph and surfaces it honestly when over the element cap", async () => {
		const overCapTempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-build-graph-cli-overcap-"),
		);
		const overCapProjectDir = path.join(overCapTempRoot, "project");
		const overCapDataDir = path.join(overCapTempRoot, "data");
		fs.mkdirSync(path.join(overCapProjectDir, "src"), { recursive: true });
		// A handful of interdependent files is enough to clear a cap of 1 element.
		for (let i = 0; i < 5; i++) {
			const importLine =
				i === 0 ? "" : `import { value${i - 1} } from "./m${i - 1}.js";\n`;
			const expr = i === 0 ? `${i}` : `${i} + value${i - 1}`;
			fs.writeFileSync(
				path.join(overCapProjectDir, "src", `m${i}.ts`),
				`${importLine}export const value${i} = ${expr};\n`,
			);
		}
		try {
			const result = await runCli(
				["build-graph", "--cwd", overCapProjectDir],
				overCapDataDir,
				{ PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS: "1" },
			);
			expect(result.code).toBe(0);
			expect(result.stdout).toMatch(/^pi-lens build-graph: PARTIAL persist/);
			expect(result.stdout).toMatch(/persistedNodes=\d+\/\d+/);
			expect(result.stdout).toMatch(/persistedEdges=\d+\/\d+/);
			expect(result.stdout).toMatch(/cap=1/);

			const snapshotPaths = fs
				.readdirSync(overCapDataDir, { recursive: true })
				.filter((entry) => String(entry).endsWith("review-graph.json.gz"))
				.map((entry) => path.join(overCapDataDir, String(entry)));
			expect(snapshotPaths).toHaveLength(1);
			const persisted = JSON.parse(
				gunzipSync(fs.readFileSync(snapshotPaths[0])).toString("utf-8"),
			) as {
				coverage?: {
					partial: boolean;
					cap: number;
					totalNodes: number;
					totalEdges: number;
					persistedNodes: number;
					persistedEdges: number;
				};
			};
			expect(persisted.coverage?.partial).toBe(true);
			expect(persisted.coverage?.cap).toBe(1);
			expect(persisted.coverage?.persistedNodes ?? 0).toBeLessThanOrEqual(
				persisted.coverage?.totalNodes ?? 0,
			);
			expect(persisted.coverage?.totalNodes ?? 0).toBeGreaterThan(0);
		} finally {
			removeTempDirSync(overCapTempRoot);
		}
	});
});
