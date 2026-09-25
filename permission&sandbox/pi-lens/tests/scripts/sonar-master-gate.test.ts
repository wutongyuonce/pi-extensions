// flake-shape: real-process-spawn — the CLI's exit codes and rendered stdout/stderr are the process-boundary contract; an in-process fetch call cannot certify the real entry point
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = resolve(ROOT, "scripts/sonar-master-gate.mjs");
const FIXTURES = resolve(ROOT, "tests/fixtures/sonar-master-gate");
const children: ReturnType<typeof spawn>[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolveClose) =>
						server.close(() => resolveClose()),
					),
			),
	);
});

function fixture(name: string) {
	return readFileSync(resolve(FIXTURES, name), "utf8");
}

async function runWithFixtures(gate: string, issues: string, gateStatus = 200) {
	const server = createServer((request, response) => {
		const body = request.url?.startsWith("/qualitygates/") ? gate : issues;
		response.writeHead(gateStatus, { "content-type": "application/json" });
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolveListen) =>
		server.listen(0, "127.0.0.1", resolveListen),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture server did not bind");
	return run({ SONAR_API_BASE_URL: `http://127.0.0.1:${address.port}` });
}

function run(env: Record<string, string>) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolveRun, reject) => {
			const child = spawn(process.execPath, [SCRIPT], {
				cwd: ROOT,
				env: { ...process.env, ...env },
			});
			children.push(child);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("error", reject);
			child.on("close", (status) => resolveRun({ status, stdout, stderr }));
		},
	);
}

describe("sonar-master-gate real entry point (#3319)", () => {
	it("reports OK through the process boundary", async () => {
		const result = await runWithFixtures(
			fixture("ok-gate.json"),
			fixture("open-vulnerabilities.json"),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SonarCloud master quality gate: OK");
	});

	it("fails and names the condition and open vulnerability (#3319 F1)", async () => {
		const result = await runWithFixtures(
			fixture("error-gate.json"),
			fixture("open-vulnerabilities.json"),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("✗ SonarCloud master quality gate: ERROR");
		expect(result.stderr).toContain(
			"new_vulnerabilities: actual 2, threshold 0",
		);
		expect(result.stderr).toContain(
			"squid:S3649, src/auth.ts:42, Change this code to not log credentials.",
		);
	});

	it("reports an unreachable SonarCloud as a warning without a quality red (#3319 F2)", async () => {
		const result = await run({ SONAR_API_BASE_URL: "http://127.0.0.1:1" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain(
			"⚠ SonarCloud master quality gate unreachable",
		);
		expect(result.stderr).toContain("treating outage as non-quality failure");
	});

	it("fails distinctly for an HTTP API failure (#3322 H-3322-1)", async () => {
		const result = await runWithFixtures(
			fixture("ok-gate.json"),
			fixture("open-vulnerabilities.json"),
			500,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"✗ SonarCloud API failure (500 Internal Server Error)",
		);
		expect(result.stderr).not.toContain("unreachable");
	});

	it("fails distinctly for malformed JSON (#3322 H-3322-1)", async () => {
		const result = await runWithFixtures(
			"not-json",
			fixture("open-vulnerabilities.json"),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("✗ SonarCloud API failure (invalid JSON");
	});

	it.each([
		["missing projectStatus.status", '{"projectStatus":{"conditions":[]}}'],
		["missing conditions", '{"projectStatus":{"status":"OK"}}'],
	])("fails distinctly for a gate shape error: %s", async (_reason, gate) => {
		const result = await runWithFixtures(
			gate,
			fixture("open-vulnerabilities.json"),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`✗ SonarCloud API failure (${_reason})`);
	});
});
