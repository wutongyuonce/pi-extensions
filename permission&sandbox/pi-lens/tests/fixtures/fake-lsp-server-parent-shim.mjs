// #2436 regression fixture: a stand-in "parent" process that spawns
// fake-lsp-server.mjs exactly the way a teardown-hostile real caller can —
// piped stdio, its own process group with no OS-level auto-reap
// (`detached: true`, the shape `launchLSP` itself uses on POSIX, and the
// shape a failed Windows job-nesting assignment degrades to; see
// tests/support/fake-lsp-server.ts for the full class of teardown paths this
// guards). Used by
// tests/clients/lsp/fake-lsp-server-parent-watchdog.test.ts to prove the
// fixture cannot outlive being SIGKILLed itself, with no graceful shutdown
// and no JS-level cleanup ever running.
//
// Drives the minimal initialize -> initialized handshake so env-gated
// post-init behavior (FAKE_LSP_WEDGE_STDIN_AFTER_INIT / FAKE_LSP_SKIP_EOF_EXIT,
// inherited from this shim's own env — set them on the shim's spawn, not the
// target's) actually arms. FAKE_LSP_WEDGE_STDIN_AFTER_INIT installs a real,
// non-`unref`'d `setInterval` in the target — the same shape a real
// wedge/CPU-liveness test in
// tests/clients/lsp/service-notify-cpu-liveness.test.ts and
// shutdown-live-wedged-process.test.ts spawns — so the parent-death
// watchdog test proves a process that is genuinely kept alive by something
// other than an unconsumed event loop still dies once its parent is gone.
// A paused stdin still delivers `end` once the underlying fd reports EOF
// (see fake-lsp-server.mjs's own comment), so stdin-EOF alone already reaps
// that case; the second target-side trigger — the `process.ppid` liveness
// poll — is exercised in isolation by additionally setting
// FAKE_LSP_SKIP_EOF_EXIT=1 on the target's env, which disables the EOF exit
// and leaves the poll as the only thing that can end the target.
//
// Usage: node fake-lsp-server-parent-shim.mjs <fake-lsp-server.mjs path>
// Prints "CHILD_PID:<pid>" to stdout once the handshake is sent, then idles
// until the test kills this process.

import { spawn } from "node:child_process";

const target = process.argv[2];
if (!target) {
	throw new Error(
		"usage: fake-lsp-server-parent-shim.mjs <fake-lsp-server.mjs path>",
	);
}

function encodeFrame(message) {
	const json = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

const child = spawn(process.execPath, [target], {
	stdio: ["pipe", "pipe", "pipe"],
	detached: true,
	env: process.env,
});
// Drain so a full pipe buffer can never make the child block on a write.
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
child.on("error", () => {});

child.stdin.write(
	encodeFrame({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { capabilities: {} },
	}),
);
child.stdin.write(
	encodeFrame({ jsonrpc: "2.0", method: "initialized", params: {} }),
);

process.stdout.write(`CHILD_PID:${child.pid}\n`);

// Keep this shim alive so the test controls exactly when (and how — SIGKILL,
// no goodbye) it dies.
setInterval(() => {}, 60_000);
