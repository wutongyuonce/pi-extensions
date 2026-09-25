import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";

type GitExecOptions = {
	cwd?: string;
	encoding?: BufferEncoding;
	stdio?: "ignore" | "pipe" | "inherit";
	env?: NodeJS.ProcessEnv;
	/** Piped to the child's stdin, e.g. feeding `git check-ignore --stdin`. */
	input?: string | Buffer;
};
type GitSpawnOptions = Parameters<
	typeof import("../../clients/safe-spawn.js").safeSpawnAsync
>[2];

const SCRUBBED_GIT_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_CONFIG_COUNT",
] as const;

// GIT_CONFIG_COUNT + GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> let a caller
// inject arbitrary config (including core.bare) without touching a config
// file at all. GIT_CONFIG_COUNT is a fixed name above; the indexed KEY/VALUE
// pair is unbounded, so it is scrubbed by pattern instead of by name.
const GIT_CONFIG_KV_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** Build the only environment a test fixture may use for a real Git process. */
export function gitFixtureEnv(fixtureDir: string): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	return scrubGitFixtureEnv(fixtureDir, env);
}

function scrubGitFixtureEnv(
	fixtureDir: string,
	base: NodeJS.ProcessEnv,
): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(base).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	for (const variable of SCRUBBED_GIT_VARIABLES) delete env[variable];
	for (const key of Object.keys(env))
		if (GIT_CONFIG_KV_PATTERN.test(key)) delete env[key];
	// These are fixture policy, not caller overrides. The harness itself may
	// already be contaminated, so delete inherited values before setting them.
	env.GIT_CONFIG_GLOBAL = path.join(fixtureDir, "gitconfig");
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

function gitFixtureEnvWithOverrides(
	fixtureDir: string,
	overrides: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
	return scrubGitFixtureEnv(fixtureDir, {
		...gitFixtureEnv(fixtureDir),
		...overrides,
	});
}

/** Install fixture isolation for production Git probes launched by a test. */
export function installGitFixtureEnv(fixtureDir: string): void {
	const env = gitFixtureEnv(fixtureDir);
	for (const variable of SCRUBBED_GIT_VARIABLES) delete process.env[variable];
	for (const key of Object.keys(process.env))
		if (GIT_CONFIG_KV_PATTERN.test(key)) delete process.env[key];
	Object.assign(process.env, env);
}

export function gitExecFileSync(
	command: string,
	args: string[],
	options: GitExecOptions & { encoding: BufferEncoding },
): string;
export function gitExecFileSync(
	command: string,
	args: string[],
	options?: GitExecOptions,
): Buffer | string;
export function gitExecFileSync(
	command: string,
	args: string[],
	options: GitExecOptions = {},
): Buffer | string {
	return execFileSync(command, args, {
		...options,
		env: gitFixtureEnvWithOverrides(options.cwd ?? process.cwd(), options.env),
	});
}

/** Run a shell-shaped Git fixture command without inheriting Git state. */
export function gitExecSync(
	command: string,
	options: GitExecOptions & { encoding: BufferEncoding },
): string;
export function gitExecSync(
	command: string,
	options?: GitExecOptions,
): Buffer | string;
export function gitExecSync(
	command: string,
	options: GitExecOptions = {},
): Buffer | string {
	return execSync(command, {
		...options,
		env: gitFixtureEnvWithOverrides(options.cwd ?? process.cwd(), options.env),
	});
}

export function hasGit(fixtureDir = process.cwd()): boolean {
	try {
		gitExecFileSync("git", ["--version"], { cwd: fixtureDir, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export { gitExecFileSync as execFileSync, gitExecSync as execSync };

export function gitFixtureSpawnAsync(
	fixtureDir: string,
	args: string[],
	options: GitSpawnOptions = {},
): ReturnType<typeof import("../../clients/safe-spawn.js").safeSpawnAsync> {
	return import("../../clients/safe-spawn.js").then(({ safeSpawnAsync }) =>
		safeSpawnAsync("git", args, {
			...options,
			cwd: options.cwd ?? fixtureDir,
			env: gitFixtureEnvWithOverrides(fixtureDir, options.env),
		}),
	);
}
