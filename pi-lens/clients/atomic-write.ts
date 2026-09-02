/**
 * Shared atomic tmp+rename file writer (closes #762).
 *
 * The `${target}.tmp-…` + `renameSync` shape was independently hand-rolled in
 * five places (`instance-registry.ts`, `session-state-store.ts`,
 * `recent-touches.ts`, `review-graph/builder.ts`, `diagnostic-dispositions.ts`)
 * as each one picked up the need for a reader to never observe a
 * partially-written file. Five independent copies of the same shape invite
 * drift (e.g. forgetting the tmp-file cleanup on the failure path) — this
 * module is the single implementation the rest re-use.
 *
 * ## What this guarantees (#1205)
 *
 * Data is written in full to a staging file that no other writer can name,
 * then `rename()`d over the target. On POSIX, `rename()` replaces the
 * destination atomically by construction. On Windows, libuv uses
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which is atomic in practice
 * on a same-volume NTFS replace but — unlike POSIX `rename()` — is not a
 * formally guaranteed atomic primitive (`ReplaceFile` /
 * `SetFileInformationByHandle` are the stronger APIs). Therefore, modulo that
 * caveat:
 *
 *   - **Crash-safe replacement.** A crash mid-write leaves the target holding
 *     its previous complete contents plus an orphan staging file; it never
 *     leaves the target half-written.
 *   - **Tear-free publication.** Any reader — same process or not — observes
 *     either the fully-old or the fully-new file at the target path. Because
 *     the staging name is unique *per call* (pid + thread id + a monotonic
 *     per-thread counter), this now holds for concurrent writes from the same
 *     process too, on any thread. Before #1205 the staging name was only
 *     `.tmp-${pid}`, so two in-flight same-process writes to one target
 *     shared a staging inode; the first `rename` published it while the
 *     second writer was still writing into it, publishing a torn hybrid file.
 *
 * ## What this explicitly does NOT provide
 *
 *   - **No read-modify-write isolation.** Concurrent read → mutate → write
 *     cycles still lose updates: each writer publishes the state it computed
 *     from the snapshot it read, and last-rename-wins silently discards the
 *     other's mutation. Callers needing this must serialize themselves (see
 *     `registryChildMutationTail` in `instance-registry.ts`).
 *   - **No ordering.** Nothing sequences concurrent writers, within or across
 *     processes. The winner is whichever `rename` lands last, which is not
 *     necessarily the write that started or finished last.
 *   - **No mutual exclusion.** This is not a lock. Overlapping writes are
 *     permitted and expected; only *torn* output is prevented.
 *   - **No fsync/durability guarantee.** Neither the staging file nor the
 *     parent directory is fsync'd, so a power loss (as opposed to a process
 *     crash) may lose the rename.
 *   - **No self-reaping.** A process killed between the staging write and the
 *     rename leaves an orphan staging file. The next session_start performs a
 *     bounded, liveness-checked sweep through the instance-reaper lifecycle
 *     seam (#1228); this writer never watches or reaps its own files.
 *   - **Windows-specific loss under `bestEffort: true`.** `MoveFileEx` with
 *     `MOVEFILE_REPLACE_EXISTING` fails if a reader holds the destination
 *     open without `FILE_SHARE_DELETE`. On Windows this silently drops the
 *     write (swallowed like any other `bestEffort: true` failure); the
 *     identical code path succeeds on POSIX, where `rename()` does not care
 *     whether a reader has the destination open.
 *
 * Per-write-site error policy varies and is NOT a detail this helper should
 * paper over:
 *
 *   - `bestEffort: true` (the default, and the majority of today's sites): a
 *     write or rename failure just means this update is lost — swallow it,
 *     after a best-effort tmp-file cleanup. Appropriate for observability
 *     substrate (instance registry, recent-touches, review-graph cache,
 *     session widget state) where a dropped write is, at worst, a stale/
 *     missing sample.
 *   - `bestEffort: false`: rethrow the failure (after the same best-effort tmp
 *     cleanup). This is `clients/diagnostic-dispositions.ts`'s policy (#757):
 *     unlike the writers above, a disposition mark is functionally
 *     load-bearing — a silently lost mark is a correctness bug, not a dropped
 *     observability sample — so callers must see the failure rather than have
 *     it swallowed. See the #757 CHANGELOG entry for the full reasoning.
 */

import * as fs from "node:fs";
export {
	STAGE_TMP_PATTERN,
	stageOwnerPidFromName,
	stagePathFor,
} from "./atomic-write-staging.js";
import { stagePathFor } from "./atomic-write-staging.js";

export interface WriteFileAtomicOptions {
	/**
	 * `true` (default): swallow write/rename failures after best-effort tmp
	 * cleanup — the update is simply lost. `false`: rethrow the failure after
	 * the same best-effort cleanup (the #757 disposition-store policy).
	 */
	bestEffort?: boolean;
	/**
	 * POSIX file mode (e.g. `0o750` for an installed executable) applied at
	 * staging-file CREATION, so it travels with the file across the rename
	 * rather than needing a separate `chmod` after publication. Ignored on
	 * Windows (Node's `fs` mode support is POSIX-only there). Omit for the
	 * default (umask-governed) mode.
	 */
	mode?: number;
}

/**
 * Monotonic counter that makes each staging path unique per CALL, not merely
 * per process (#1205).
 *
 * A counter is used rather than `randomBytes`: it is allocation-free and
 * synchronous on what are hot per-turn/per-touch write paths, and it is
 * *exactly* as unique as needed — collisions only matter between two writes
 * live at the same instant, and a monotonic counter makes those impossible by
 * construction rather than merely improbable.
 *
 * The counter alone is per-THREAD, not per-process: a worker gets its own
 * module instance and so its own `_stageSeq` starting at 0, while sharing
 * `process.pid` with the main thread and every sibling worker. Two threads
 * would therefore each mint `${target}.tmp-<samepid>-0` — the exact collision
 * the counter exists to prevent. `threadId` (0 on the main thread, distinct
 * per worker) closes that axis, so the three parts cover the three ways two
 * writes can be concurrent: `process.pid` across processes, `threadId` across
 * threads, `_stageSeq` within one thread (#1217).
 */
/**
 * Staging path for one write call: `${targetPath}.tmp-<pid>-<threadId>-<seq>`.
 *
 * Exported so that callers which cannot use {@link writeFileAtomic} wholesale
 * — `gzip-stage-write.ts` needs its own streaming pipeline — still source the
 * *name* here rather than re-deriving the scheme, and so that sweepers of
 * orphaned staging files stay in lockstep with it (see
 * {@link STAGE_TMP_PATTERN}).
 */
/**
 * Matches the trailing staging-file marker produced by {@link stagePathFor},
 * for the session-start sweeper that garbage-collects staging files orphaned
 * by a crashed process (#1228). The writer itself does not reap or watch files.
 *
 * Only the current four-component shape is matched:
 * `.tmp-<pid>-<threadId>-<seq>` (#1217). Older one- and two-number suffixes
 * are deliberately left alone: their shape is indistinguishable from
 * legitimate user filenames, so deletion safety outweighs reclaiming the
 * handful of pre-#1208 leftovers.
 *
 * CAUTION for any sweeper adopting this pattern: it matches staging files by
 * shape, not by writer identity, so it also matches this process's own
 * still-being-written staging files. A safe sweeper must separately protect
 * `process.pid` and use the shared conservative liveness check for foreign
 * pids. The review-graph builder's narrower stage sweep intentionally remains
 * separate because it owns a different `.stage-<pid>-<generation>` namespace.
 *
 * Anchoring is correct for both consumer styles in this repo today
 * (matching against a full path or a bare basename), but this is confined to
 * pi-lens's own cache directories — a consumer sweeping a directory it does
 * not fully control should not assume every match is one of this module's
 * staging files.
 */

/**
 * Synchronous atomic write of text or binary data to a per-call staging file,
 * then `fs.renameSync` over `targetPath`. On any failure (from either step),
 * attempts a best-effort `fs.rmSync(tmp, { force: true })` cleanup, then
 * either swallows (default) or rethrows per `options.bestEffort`.
 *
 * Does not create the parent directory — callers that need one must
 * `mkdirSync` before calling this (matches every existing call site, which
 * already does its own mkdir as a separate step).
 */
export function writeFileAtomic(
	targetPath: string,
	data: string | Uint8Array,
	options?: WriteFileAtomicOptions,
): void {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = stagePathFor(targetPath);
	try {
		fs.writeFileSync(tmpPath, data, {
			encoding: typeof data === "string" ? "utf-8" : undefined,
			mode: options?.mode,
		});
		fs.renameSync(tmpPath, targetPath);
	} catch (err) {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}

/**
 * Async counterpart of {@link writeFileAtomic}, built on `fs.promises` instead
 * of the sync `fs` API — for call sites that must not block the event loop
 * (e.g. writes on a hot per-turn/per-touch path). Same per-call tmp-naming,
 * cleanup, and `bestEffort` semantics.
 */
export async function writeFileAtomicAsync(
	targetPath: string,
	data: string | Uint8Array,
	options?: WriteFileAtomicOptions,
): Promise<void> {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = stagePathFor(targetPath);
	try {
		await fs.promises.writeFile(tmpPath, data, {
			encoding: typeof data === "string" ? "utf-8" : undefined,
			mode: options?.mode,
		});
		await fs.promises.rename(tmpPath, targetPath);
	} catch (err) {
		try {
			await fs.promises.rm(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}
