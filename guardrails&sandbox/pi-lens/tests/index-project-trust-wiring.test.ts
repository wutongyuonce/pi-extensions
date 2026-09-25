import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import {
	getProjectTrustState,
	resetProjectTrust,
} from "../clients/project-trust.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// Same two heavy seams tests/index-wiring.test.ts stubs, so firing
// session_start stays a fast deterministic wiring check.
vi.mock("../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}),
}));
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const tmpDirs: string[] = [];

function tmpProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-trust-wiring-"));
	tmpDirs.push(dir);
	return dir;
}

beforeEach(() => {
	resetProjectTrust();
});

afterEach(() => {
	resetProjectTrust();
	for (const dir of tmpDirs.splice(0)) removeTempDirSync(dir);
});

/**
 * #1334 S5 — pi-lens CONSUMES the host trust decision through
 * `ctx.isProjectTrusted()` at session_start. It must never register a
 * `project_trust` HANDLER: answering that question on the user's behalf is the
 * host's job, and an extension that answers it would defeat the prompt.
 */
describe("session_start project-trust adoption (#1334 S5)", () => {
	it("never registers a project_trust handler", () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		expect(pi.getHandlers("project_trust")).toHaveLength(0);
	});

	it("latches 'untrusted' when the host denies trust", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: false }),
		);

		expect(getProjectTrustState()).toBe("untrusted");
	});

	it("latches 'trusted' when the host grants trust", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: true }),
		);

		expect(getProjectTrustState()).toBe("trusted");
	});

	it("stays 'unknown' on a host that exposes no trust accessor", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit("session_start", {}, makeCtx({ cwd: tmpProject() }));

		expect(getProjectTrustState()).toBe("unknown");
	});

	it("re-reads on every session_start so a denial is not sticky", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: false }),
		);
		expect(getProjectTrustState()).toBe("untrusted");

		await pi.emit(
			"session_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: true }),
		);
		expect(getProjectTrustState()).toBe("trusted");
	});

	it("re-adopts on turn_start so mid-session trust changes converge", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: false }),
		);
		expect(getProjectTrustState()).toBe("untrusted");

		await pi.emit(
			"turn_start",
			{},
			makeCtx({ cwd: tmpProject(), isProjectTrusted: true }),
		);
		expect(getProjectTrustState()).toBe("trusted");
	});
});
