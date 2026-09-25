import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Windows keeps a file handle inside a just-used temp dir alive briefly after
// a child process/watcher/background scan exits (AV scanning, delayed handle
// release, or — as in #810's runtime-session.test.ts case — a fire-and-forget
// background task the test didn't wait to settle before tearing down). An
// immediate recursive `rm` can race that and throw EPERM/ENOTEMPTY (#793,
// #810). `maxRetries`/`retryDelay` gives Windows a moment to release the
// handle; if it's STILL held after retrying, a leftover temp dir under the
// OS temp root is harmless (the OS reclaims it eventually) while failing the
// whole test run over teardown is not — so the final failure warns instead
// of throwing. This is the ONE shared cleanup helper for test temp dirs
// (#810's pattern-class rule) — route every ad-hoc `fs.rmSync(dir, {
// recursive: true, force: true })` teardown through this instead of
// hand-rolling retries per suite.
export function removeTempDirSync(dir: string): void {
	try {
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch (err) {
		process.stderr.write(
			`[test cleanup] could not remove temp dir ${dir}: ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		);
	}
}

export function setupTestEnvironment(prefix = "pi-lens-test-"): {
	tmpDir: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	activeTestEnvironments.add(tmpDir);
	return {
		tmpDir,
		cleanup: () => {
			removeTempDirSync(tmpDir);
			// Keep the root tracked: deferred work can recreate it before the
			// owning family's cleanup sweep runs.
		},
	};
}

const activeTestEnvironments = new Set<string>();

export function cleanupTestEnvironments(
	prefix: string,
	options: { untrack?: boolean } = {},
): void {
	for (const tmpDir of activeTestEnvironments) {
		if (!path.basename(tmpDir).startsWith(prefix)) continue;
		removeTempDirSync(tmpDir);
		if (options.untrack !== false && !fs.existsSync(tmpDir)) {
			activeTestEnvironments.delete(tmpDir);
		}
	}
}

/**
 * Drain deferred fixture producers before the final cleanup pass. Keeping
 * roots tracked until the last tick preserves the hygiene sweep's handle.
 */
export async function cleanupTestEnvironmentsDrained(
	prefix: string,
	options: { beforeDrain?: () => Promise<void> } = {},
): Promise<void> {
	await options.beforeDrain?.();
	for (let tick = 0; tick < 3; tick++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (tick === 2) {
			// The final producer turn can be queued by the preceding drain.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		cleanupTestEnvironments(prefix, { untrack: tick === 2 });
	}
}

/**
 * A file reachable under TWO spellings that differ only in case, where the
 * kernel reports the on-disk spelling for both — the exact contract
 * `normalizeFilePath`'s POSIX arm depends on (#3098, the live half of #1024:
 * a raw mis-cased `lens_diagnostic_mark` write and a `normalizeMapKey` read
 * deriving two anchors for one file, so the agent's own mark never applies).
 *
 * Built natively where the filesystem is case-insensitive (macOS APFS/HFS+,
 * Windows, `nocase` vfat/ntfs3/cifs). On a case-sensitive filesystem — the
 * ubuntu Unit tests lane — the same observable contract is manufactured with a
 * case-variant symlink (`SUB` → `sub`): `existsSync(SUB/a.ts)` is true and
 * `realpathSync.native` returns `sub/a.ts`, byte-identical to what APFS
 * answers, so the seam under test cannot tell the two fixtures apart and the
 * guard runs on EVERY lane instead of skipping on the one CI actually has.
 *
 * `skipReason` is set — and the case cases must skip visibly — only where the
 * kernel cannot supply that contract: a Linux ext4/tmpfs casefold directory
 * aliases the spellings but `realpath(3)` returns the QUERIED casing (measured
 * in #3154), so there is nothing for the normalizer to canonicalize toward.
 */
export function createCaseAliasFixture(
	baseDir: string,
	options: { dirName?: string; fileName?: string; content?: string } = {},
): {
	/** Mis-cased spelling, as a raw `path.resolve(cwd, arg)` would carry it. */
	rawMisCased: string;
	/** The spelling really on disk. */
	onDisk: string;
	/** Set when this filesystem cannot report on-disk casing (see above). */
	skipReason?: string;
} {
	const dirName = options.dirName ?? "sub";
	const fileName = options.fileName ?? "a.ts";
	const onDiskDir = path.join(baseDir, dirName);
	fs.mkdirSync(onDiskDir, { recursive: true });
	const onDisk = path.join(onDiskDir, fileName);
	fs.writeFileSync(onDisk, options.content ?? "const target = bad();\n");

	const misCasedDir = path.join(baseDir, dirName.toUpperCase());
	const rawMisCased = path.join(misCasedDir, fileName);
	if (!fs.existsSync(rawMisCased)) {
		try {
			fs.symlinkSync(dirName, misCasedDir, "dir");
		} catch (err) {
			return {
				rawMisCased,
				onDisk,
				skipReason: `cannot alias ${dirName} as ${dirName.toUpperCase()}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}
	let canonical: string | undefined;
	try {
		canonical = fs.realpathSync.native(rawMisCased);
	} catch {
		canonical = undefined;
	}
	return canonical === undefined || canonical === rawMisCased
		? {
				rawMisCased,
				onDisk,
				skipReason:
					"filesystem aliases the two spellings but reports the QUERIED casing, " +
					"not the on-disk one (Linux casefold directory) — refs #3154",
			}
		: { rawMisCased, onDisk };
}

export function createTempFile(
	baseDir: string,
	relativePath: string,
	content: string,
): string {
	const filePath = path.join(baseDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}
