/**
 * #1857 — the POSIX enumeration asks `ps` for an `etime` column it never
 * needed before. If the host's `ps` rejects the column vector, `ps` writes
 * usage text to stderr and exits with EMPTY stdout, which the sweep would
 * read as "ran fine, found nothing": the backstop would go silently dead on
 * every POSIX machine.
 *
 * That is the one part of the fix a Windows development host cannot check, so
 * it is checked here against the REAL `ps`, on the real CI runner. No mocks.
 *
 * #2443 moved the argument vector and the etime parser into the shared
 * process-table seam. This suite follows them: it now spawns the command the
 * SEAM composes for the reaper's projection, rather than a copy of it, so a
 * column the host's `ps` rejects reds here instead of in production.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	ageMsFromPosixEtime,
	buildProcessQuery,
} from "../../scripts/lib/process-scan.mjs";

/** Exactly the projection `enumerateManagedProcesses` asks for. */
const REAPER_FIELDS = ["pid", "ppid", "ageMs", "command"] as const;

/** Probe the filesystem for `ps`, not `process.platform`: the question is
 *  whether this host HAS the binary the sweep spawns. */
const hasPs = existsSync("/bin/ps") || existsSync("/usr/bin/ps");

function runPs(): Promise<{ stdout: string; code: number | null }> {
	const query = buildProcessQuery(REAPER_FIELDS);
	return new Promise((resolve) => {
		const child = spawn(query.command, query.args, {
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.once("error", () => resolve({ stdout: "", code: null }));
		child.once("close", (code) => resolve({ stdout, code }));
	});
}

describe.skipIf(!hasPs)(
	"#1857: the real ps accepts the etime column vector",
	() => {
		it("asks for the header-suppressed pid/ppid/etime/args projection", () => {
			// Pinned so a seam change that silently dropped a column (which would
			// put the command line where the age token belongs) fails here rather
			// than by making every process look unknown-aged in production.
			const query = buildProcessQuery(REAPER_FIELDS);
			expect(query.args).toEqual(["-eo", "pid=,ppid=,etime=,args="]);
			expect(query.tabSeparated).toBe(false);
		});

		it("exits zero and returns rows whose third column parses as an age", async () => {
			const { stdout, code } = await runPs();

			expect(code).toBe(0);
			const rows = stdout.split("\n").filter((line) => line.trim().length > 0);
			expect(rows.length).toBeGreaterThan(0);

			// Every row must yield a usable age. A `ps` that silently dropped the
			// column would put the command line in the third token, which
			// `ageMsFromPosixEtime` rejects — and a rejected age means the grace
			// guard spares everything, i.e. a dead backstop.
			const ages = rows.map((row) => {
				const tokens = row.trim().split(/\s+/);
				return ageMsFromPosixEtime(tokens[2] ?? "");
			});
			const usable = ages.filter((age) => typeof age === "number");
			expect(usable.length).toBe(rows.length);
		});

		it("reports this test process as younger than a day", async () => {
			const { stdout } = await runPs();
			const mine = stdout
				.split("\n")
				.map((row) => row.trim().split(/\s+/))
				.find((tokens) => Number(tokens[0]) === process.pid);

			expect(
				mine,
				"the test process must appear in ps -e output",
			).toBeDefined();
			const ageMs = ageMsFromPosixEtime(mine?.[2] ?? "");
			expect(typeof ageMs).toBe("number");
			expect(ageMs).toBeLessThan(24 * 60 * 60 * 1000);
		});
	},
);

describe("ageMsFromPosixEtime", () => {
	it("parses every etime shape ps emits", () => {
		expect(ageMsFromPosixEtime("00:05")).toBe(5_000);
		expect(ageMsFromPosixEtime("12:34")).toBe(754_000);
		expect(ageMsFromPosixEtime("01:02:03")).toBe(3_723_000);
		expect(ageMsFromPosixEtime("2-03:04:05")).toBe(
			((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000,
		);
	});

	it("rejects anything that is not an etime, so the age reads as unknown", () => {
		expect(ageMsFromPosixEtime("")).toBeUndefined();
		expect(ageMsFromPosixEtime("-")).toBeUndefined();
		// What a ps that dropped the column would put in the third token.
		expect(ageMsFromPosixEtime("/usr/bin/node")).toBeUndefined();
	});
});
