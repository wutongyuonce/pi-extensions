/** Owns the generic atomic-write `.tmp-<pid>-<threadId>-<seq>` namespace. */

import * as fs from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";

let stageSeq = 0;

export const STAGE_TMP_PATTERN =
	/\.tmp-(0|[1-9]\d*)-(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const STAGE_TMP_PID_PATTERN =
	/\.tmp-(0|[1-9]\d*)-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/;

export function stagePathFor(targetPath: string): string {
	return `${targetPath}.tmp-${process.pid}-${threadId}-${stageSeq++}`;
}

export function stageOwnerPidFromName(name: string): number | undefined {
	if (!STAGE_TMP_PATTERN.test(name)) return undefined;
	const match = STAGE_TMP_PID_PATTERN.exec(name);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export interface AtomicStageSweepResult {
	directories: number;
	scanned: number;
	removed: number;
	liveSkipped: number;
	truncated: boolean;
}

export async function sweepOwnStagingFiles(
	directories: readonly string[],
	options: { maxEntries: number; isPidAlive: (pid: number) => boolean },
): Promise<AtomicStageSweepResult> {
	const uniqueDirectories = [...new Set(directories)].filter(Boolean);
	const result: AtomicStageSweepResult = {
		directories: uniqueDirectories.length,
		scanned: 0,
		removed: 0,
		liveSkipped: 0,
		truncated: false,
	};
	for (const directory of uniqueDirectories) {
		let handle: fs.Dir;
		try {
			handle = await fs.promises.opendir(directory);
		} catch {
			continue;
		}
		try {
			let reachedEntryCap = true;
			for (let i = 0; i < options.maxEntries; i++) {
				const entry = await handle.read();
				if (entry === null) {
					reachedEntryCap = false;
					break;
				}
				result.scanned++;
				if (!entry.isFile()) continue;
				const pid = stageOwnerPidFromName(entry.name);
				if (pid === undefined) continue;
				if (pid === process.pid || options.isPidAlive(pid)) {
					result.liveSkipped++;
					continue;
				}
				try {
					await fs.promises.rm(path.join(directory, entry.name), {
						force: true,
					});
					result.removed++;
				} catch {
					/* leave it for the next bounded sweep */
				}
			}
			result.truncated ||= reachedEntryCap;
		} catch {
			/* best-effort directory scan */
		} finally {
			await handle.close().catch(() => {});
		}
	}
	return result;
}
