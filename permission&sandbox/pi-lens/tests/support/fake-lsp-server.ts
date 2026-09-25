/**
 * THE ONE spawn path for `tests/fixtures/fake-lsp-server.mjs` (#2436).
 *
 * Before this, every real-LSP-wire test hand-rolled its own
 * `launchLSP(process.execPath, [FAKE_SERVER_PATH], { cwd, env })` call (15
 * files, ~40 call sites) with cleanup left entirely to each test's own
 * `afterEach`/try-finally. A vitest worker fork that is force-killed under
 * load — or by tinypool's own "Timeout terminating forks worker" escape
 * hatch (see vitest.config.ts) — never runs that `afterEach`, so the fixture
 * process outlived it: a real orphan was found on disk an hour after its
 * parent process no longer existed, holding its worktree directory open
 * (`git worktree remove` → Permission denied / Device or resource busy).
 *
 * Two independent defenses, because neither alone is airtight against every
 * real teardown shape:
 *
 *   1. `spawnFakeLspServer` here registers an `onTestFinished` kill — a
 *      guaranteed last-resort teardown that runs even if the caller's own
 *      cleanup throws, is skipped, or was simply never written, so a new
 *      call site cannot reintroduce the leak by omission.
 *   2. `tests/fixtures/fake-lsp-server.mjs` itself now self-terminates on
 *      stdin EOF and on losing its original parent (see the fixture's
 *      comment for why that needs two triggers, not one) — the backstop for
 *      the shape (1) cannot reach: the JS-level hook never running at all
 *      because the whole worker process was SIGKILLed before its teardown
 *      queue could drain.
 *
 * Regression coverage for the fixture's own watchdog lives in
 * `tests/clients/lsp/fake-lsp-server-parent-watchdog.test.ts`.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { LSPProcess } from "../../clients/lsp/launch.js";
import { launchLSP } from "../../clients/lsp/launch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixture — exported for the rare caller that needs it
 *  directly (e.g. to reference it in an argv list for a subprocess). Prefer
 *  `spawnFakeLspServer` over reading this path and calling `launchLSP`. */
export const FAKE_LSP_SERVER_PATH = path.join(
	__dirname,
	"../fixtures/fake-lsp-server.mjs",
);

export interface SpawnFakeLspServerOptions {
	/** Defaults to `process.cwd()`, matching every existing call site. */
	cwd?: string;
	/** Defaults to `process.env` (unmodified) if omitted. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Spawn `tests/fixtures/fake-lsp-server.mjs` through the real `launchLSP`
 * production path (the same seam a real language-server launch uses) and
 * register a guaranteed kill for when the calling test finishes — pass,
 * fail, or throw before its own cleanup runs.
 */
export async function spawnFakeLspServer(
	options: SpawnFakeLspServerOptions = {},
): Promise<LSPProcess> {
	const { cwd = process.cwd(), env } = options;
	const proc = await launchLSP(process.execPath, [FAKE_LSP_SERVER_PATH], {
		cwd,
		...(env ? { env } : {}),
	});
	onTestFinished(() => {
		const { process: child } = proc;
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	});
	return proc;
}
