#!/usr/bin/env node
/**
 * scripts/with-memory-watch.mjs (#2042)
 *
 * Runs a command while sampling host memory, so an OOM kill leaves evidence.
 *
 * The problem it solves is not memory use, it is memory ATTRIBUTION. The CI
 * Unit-tests job was SIGKILLed repeatedly with `Killed npm test` and exit 137
 * and zero failing assertions. That output names no file, no process, and no
 * number, so every occurrence reads as infrastructure noise and costs a judged
 * rerun. This wrapper prints the host's memory low-water mark and a verdict
 * line, so the next exit 137 is a claim about memory that a reader can check.
 *
 * It never changes what runs, and it forwards the child's exit code and signal
 * unchanged -- a killed run still fails the job.
 *
 * Usage:
 *   node scripts/with-memory-watch.mjs -- <command> [args...]
 *
 * Env:
 *   PI_LENS_MEM_WATCH_INTERVAL_MS   Sampling period (default 2000).
 *   PI_LENS_MEM_WATCH_LOW_MB        Print every sample at or below this many
 *                                   MB available (default 1024).
 *   PI_LENS_MEM_WATCH_STEP_MB       Print when available memory has fallen this
 *                                   far since the last printed line
 *                                   (default 1024).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { formatVerdict, readMemory, shouldPrint } from "./lib/memory-watch.mjs";

/**
 * Every line this wrapper emits goes through a BLOCKING write, never
 * `process.stdout.write` or `process.stderr.write`.
 *
 * When stdout is a pipe, Node buffers writes and flushes them asynchronously,
 * and `process.exit()` discards whatever is still queued. A reader that has
 * fallen behind — a log collector under memory pressure, which is precisely the
 * scenario this file exists for — fills the pipe, so the verdict line is queued
 * rather than written, and then thrown away microseconds later. The #2093
 * review reproduced that 3/3 with a slow reader: correct exit code, no verdict
 * line. On Linux, `fs.writeSync` blocks until the bytes reach the OS, so the
 * record survives.
 *
 * On Windows this is NOT sufficient: pipe-buffered bytes can be discarded at
 * process teardown even after `fs.writeSync` reports a complete write (the
 * #2093 verify reproduced the loss post-fix, `ok bytes=86 of 86` and no line at
 * the reader). That is a separate OS teardown behavior no write mechanism here
 * closes. The wrapper's durability guarantee is CI-grade (Linux) only.
 */
function emit(line, fd = 1) {
	fs.writeSync(fd, line);
}

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
	emit("usage: node scripts/with-memory-watch.mjs -- <command> [args...]\n", 2);
	process.exit(2);
}

const intervalMs = Number(process.env.PI_LENS_MEM_WATCH_INTERVAL_MS) || 2000;
const thresholdMb = Number(process.env.PI_LENS_MEM_WATCH_LOW_MB) || 1024;
const stepMb = Number(process.env.PI_LENS_MEM_WATCH_STEP_MB) || 1024;

const first = readMemory();
emit(
	`[mem-watch] host cpus=${os.availableParallelism?.() ?? os.cpus().length} ` +
		`totalMb=${first.totalMb} availableMb=${first.availableMb} ` +
		`source=${first.source} intervalMs=${intervalMs} ` +
		// #2042 round 2: the kernel's own record names a pid and a comm
		// ("Killed process 2477 (npm)"). Without these pids in the log there is
		// nothing to match it against, and the two observed victims are exactly
		// these two processes: the wrapper itself (run 32908647308) and its
		// `npm` child (run 33010136296).
		`watcherPid=${process.pid}\n`,
);

const watch = {
	totalMb: first.totalMb,
	lowWaterMb: first.availableMb,
	lowWaterAt: null,
	childPid: null,
	// The verdict states what this cadence cannot see, so it has to carry it.
	intervalMs,
};
const state = { lastPrintedMb: null, thresholdMb, stepMb };

const timer = setInterval(() => {
	const sample = readMemory();
	const at = new Date().toISOString().slice(11, 19);
	if (sample.availableMb < watch.lowWaterMb) {
		watch.lowWaterMb = sample.availableMb;
		watch.lowWaterAt = at;
	}
	if (shouldPrint(sample, state)) {
		state.lastPrintedMb = sample.availableMb;
		emit(
			`[mem-watch] ${at} availableMb=${sample.availableMb} of ${sample.totalMb}\n`,
		);
	}
}, intervalMs);
// The watcher must never be the reason the process stays alive.
timer.unref?.();

// CI-only, and CI is Linux. The win32 branch is a courtesy for running the
// wrapper by hand on a dev box: Windows cannot exec `npm` without a shell, and
// `shell: true` concatenates rather than escapes the arguments, so a path with
// a space or a shell metacharacter would be mis-parsed. Do not build a Windows
// job on this.
const child = spawn(command[0], command.slice(1), {
	stdio: "inherit",
	shell: process.platform === "win32",
});
watch.childPid = child.pid ?? null;

child.on("error", (error) => {
	clearInterval(timer);
	emit(`[mem-watch] failed to spawn: ${error.message}\n`, 2);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	clearInterval(timer);
	emit(`${formatVerdict({ code, signal }, watch)}\n`);
	// Re-raising the signal would make this wrapper's own death the story. Map
	// it to the shell's 128+n instead, which is the code CI already reports.
	if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
	process.exit(code ?? 1);
});
