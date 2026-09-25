// flake-shape: real-process-spawn — the subject IS the guard's own
// stdin/exit-code/stderr contract (what Claude Code's PreToolUse dispatch
// actually invokes); an in-process call to the exported classify functions
// cannot see a drift in that contract. Admitted in vitest.config.ts's
// wallClockBudgetInclude. The transcript harness also pins a bounded
// end-to-end budget for its 1,122 real hook processes.
//
// #2699 (refs umbrella #2697): PreToolUse Bash guard hook.
//
// Spawns the real script as a child process with the PreToolUse JSON on
// stdin -- not just the exported classify functions -- because the
// acceptance criterion is the CLI's own stdin/exit-code/stderr contract
// (what Claude Code actually invokes), the same reasoning
// tests/scripts/classify-ci-failure-cli.test.ts documents for its own CLI:
// an in-process call to the exported functions can't notice a drift in the
// stdin shape, the exit code, or which stream carries the message.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyPayload,
	findDeny,
	RULE_MESSAGES,
	scannableRegions,
	splitSegments,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import type { DenyRule } from "../../scripts/hooks/guard-bash.d.mts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOOK = join(repoRoot, "scripts", "hooks", "guard-bash.mjs");

// Every env var this suite's own process runs under, MINUS PI_LENS_HOME --
// so a negative (deny) case can never pass because the outer test runner
// happens to have PI_LENS_HOME set (probe hygiene: this repo's own worktree
// convention sets it for ad-hoc probes), and a positive (PI_LENS_HOME
// ambient) case sets it back deliberately.
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key !== "PI_LENS_HOME"),
);

function runHook(command: string, env: NodeJS.ProcessEnv = BASE_ENV) {
	return spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({
			session_id: "test",
			cwd: repoRoot,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
		encoding: "utf8",
		env,
	});
}

// Every deny string the issue lists, with the rule keyword its message must
// name (the acceptance criterion: "assert exit code AND the message names
// the rule").
const DENY_CASES: Array<[command: string, ruleNeedle: string]> = [
	["git stash", "stash"],
	["git stash list", "stash"],
	["git stash pop", "stash"],
	["git stash apply", "stash"],
	["git stash drop", "stash"],
	["git stash push", "stash"],
	["git -C /tmp/some-worktree stash", "stash"],
	// a quoted -C argument with an internal space must still fuse into ONE
	// word, or the -C pairing misaligns and "stash" is missed.
	['git -C "/tmp/some dir" stash', "stash"],
	["git reset --soft origin/master", "reset"],
	["git reset --soft origin/fix/2699-guard-bash-hook", "reset"],
	["git reset --hard HEAD", "reset"],
	["git reset --hard abc1234", "reset"],
	["git worktree remove -f -f /tmp/tree", "worktree"],
	["git worktree remove --force --force /tmp/tree", "worktree"],
	["git worktree remove -ff /tmp/tree", "worktree"],
	["node -e \"require('./clients/foo.js')\"", "probe"],
	["node --eval \"require('./clients/foo.js')\"", "probe"],
	["node --input-type=module -e \"import('./clients/foo.js')\"", "probe"],
	["node -p \"require('./clients/foo.js')\"", "probe"],
	["node clients/probe.mjs", "probe"],
	["node dist/probe.js", "probe"],
	["nodejs -e \"require('./clients/foo.js')\"", "probe"],
	// nested inside a subshell -- the tokenizer must recurse into $()/backticks.
	["echo $(git stash)", "stash"],
	["echo `git stash`", "stash"],
	// a non-PI_LENS_HOME env assignment must not defeat env-assignment
	// stripping -- the command word search must still land on "node".
	["FOO=bar node -e \"require('./clients/foo.js')\"", "probe"],
	// review round 2 F1: a real command placed AFTER a heredoc's closing
	// delimiter, on the same overall command, is still a live command.
	["cat <<EOF\nharmless text\nEOF\ngit stash", "stash"],
	// review round 2 F4: a leading "./" or an absolute path under clients/
	// must still be recognized (segment membership, not a prefix string).
	["node ./clients/probe.mjs", "probe"],
	// review round 2 F7: runner-prefix words, a path to git, a `-c` global
	// option, a single `&` separator, `{ …; }` grouping, and a backslash-
	// newline continuation must not defeat stash detection.
	["command git stash", "stash"],
	["exec git stash", "stash"],
	["env git stash", "stash"],
	["/usr/bin/git stash", "stash"],
	["./git stash", "stash"],
	["git -c user.name=agent stash", "stash"],
	["cd /tmp & git stash", "stash"],
	["{ git stash; }", "stash"],
	["git \\\nstash", "stash"],
	// review round 3 V5: `sudo` and `time` are runner prefixes -- both
	// confirmed against real bash to run their argument.
	["sudo git stash", "stash"],
	["time git stash", "stash"],
	// review round 3 V3b: a CRLF command text. Before this round the
	// delimiter line "EOF\r" never matched "EOF", so the body ran to
	// end-of-text and silently swallowed the real command after it.
	["cat <<'EOF'\r\nbody\r\nEOF\r\ngit stash", "stash"],
	// review round 3: bash drops a backslash before an ordinary character,
	// so this really does run git stash.
	["\\g\\i\\t stash", "stash"],
	// review round 3: `( … )` command grouping (round 2 documented this as
	// unhandled; segment splitting on the metacharacters makes it free).
	["(cd /tmp && git stash)", "stash"],
	// review round 3 V3a (LX-5-4), through the real CLI: an UNQUOTED
	// heredoc delimiter does not stop bash expanding $( ) in the body --
	// verified by running it with a side-effecting stand-in.
	["cat <<EOF\n$(git stash)\nEOF", "stash"],
	// review round 2 F1: a valid substitution before an unclosed one must
	// remain visible to the guard, because bash expands it before reporting
	// the later malformed substitution.
	["cat <<EOF\n$(git stash)\n$(echo harmless\nEOF\ngit diff", "stash"],
	// verify round 2: the backtick flush is a separate branch in the hook, so
	// it needs its own case -- deleting only that branch left the `$( )` case
	// green while this one allowed.
	["cat <<EOF\n`git stash`\n`echo harmless\nEOF\ngit diff", "stash"],
	// W1 (#2726): a here-string is not a heredoc marker.  The command after
	// it remains live and must still be classified.
	["grep x <<< foo\ngit stash", "stash"],
	// #3026 (2026-09-15), the recurrence this rule prevents: a fixer aimed
	// TMPDIR at the vitest harness's own PI_LENS_HOME, then reported "16
	// suites red on origin/master" from a tree that was green. The command
	// is VERBATIM from that PR body. Measured on this branch:
	// tests/clients/ext-gate-before-ignore.test.ts is 8/8 green with TMPDIR
	// elsewhere and 7 failed / 1 passed with this prefix.
	[
		"TMPDIR=$PWD/.probe-home npx vitest run tests/clients/ext-gate-before-ignore.test.ts",
		"tmpdir",
	],
	// The export spelling of the same offence -- a separate branch of
	// classifySegment (the export builtin never runs a trailing command, so
	// it returns before the command dispatch).
	["export TMPDIR=$PWD/.probe-home && npm test", "tmpdir"],
	// A quoted value, and an absolute path: segment membership, not a
	// $PWD-prefix string match, is what decides.
	['TMPDIR="/home/dev/wt/.probe-home" npm test', "tmpdir"],
	// A directory UNDER the harness home is the same collision.
	["TMPDIR=$PWD/.probe-home/tmp npm test", "tmpdir"],
	// TMP and TEMP reach os.tmpdir() too (measured; see TEMP_DIR_VARS).
	["TMP=$PWD/.probe-home npm test", "tmpdir"],
	["TEMP=$PWD/.probe-home npm test", "tmpdir"],
	// The variable spelling of the same directory -- what an agent reaches
	// for straight after reading the `probe` rule's own message.
	["TMPDIR=$PI_LENS_HOME npx vitest run tests/config", "tmpdir"],
	["TMPDIR=${PI_LENS_HOME}/x npx vitest run tests/config", "tmpdir"],
	["TMPDIR=$PI_LENS_HOME/sub npx vitest run tests/config", "tmpdir"],
];

// Every allow string the issue lists, which must stay green.
const ALLOW_CASES: string[] = [
	"git diff > fix.patch",
	"git checkout HEAD -- x",
	"git worktree remove -f /tmp/tree",
	"git worktree remove --force /tmp/tree",
	"git reset HEAD~1",
	"git log --grep=stash",
	'echo "git stash"',
	"PI_LENS_HOME=/x node -e \"require('./clients/foo.js')\"",
	"node scripts/ci-verdict.mjs 1",
	"npx vitest run tests/clients/foo.test.ts",
	"npm test",
	"npm run build",
	"echo hi",
	// node with neither an eval flag nor a .mjs/.js file argument, even
	// though the text mentions clients/ -- the flag/file-arg gate, not the
	// clients/dist reference alone, must decide.
	"node -c clients/tsconfig.json",
	// node -e with no clients/ or dist/ reference at all -- the reference
	// gate, not the eval flag alone, must decide.
	'node -e "console.log(1)"',
	// --soft with no origin/ target -- only "--soft origin/<branch>" denies.
	"git reset --soft HEAD~1",
	// worktree subcommand other than "remove" -- the remove check, not a
	// bare "worktree" match, must decide.
	"git worktree list",
	// double-force on a non-"remove" worktree subcommand -- the rule is
	// "remove with two forces", not "worktree with two forces anywhere".
	"git worktree add /tmp/new-tree -f -f",
	// $(...) fully inside single quotes is literal text to bash (no
	// expansion), so the tokenizer must not extract it as a subshell.
	"echo '$(git stash)'",
	// review round 2 F1: the reviewer's own reproduction set -- a heredoc
	// body mentioning a forbidden command (as literal text, or inside a
	// markdown inline-code span) is not a live command, in each of these
	// shapes: a $()-wrapped `cat` heredoc feeding a CLI flag, a bare `cat`
	// redirect, a `git commit -F` heredoc, and a heredoc through a
	// different interpreter (python) whose own quoting happens to also
	// protect it.
	"gh pr create --body \"$(cat <<'EOF'\nSome text mentions `git stash` inline but is not a command.\nEOF\n)\"",
	"cat > CLAUDE.md <<'EOF'\n- `git stash` is forbidden.\nEOF",
	"gh issue comment 2699 --body \"$(cat <<'EOF'\nDo not run `git reset --hard HEAD`.\nEOF\n)\"",
	"git commit -F - <<'EOF'\nfix: mentions `git stash` in the body\nEOF",
	"python3 <<'PYEOF'\nprint(\"do not run git reset --soft origin/master\")\nPYEOF",
	// review round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<dir>` as
	// an earlier `;`/newline-separated segment, not only this segment's own
	// prefix or process.env.
	"export PI_LENS_HOME=/x/.probe-home; node -e \"require('./clients/foo.js')\"",
	"export PI_LENS_HOME=/x/.probe-home\nnode -e \"require('./clients/foo.js')\"",
	// review round 2 F4: a leading "./" before scripts/, and an absolute
	// path under scripts/, must still be recognized as exempt.
	"node ./scripts/ci-verdict.mjs 1",
	"node /home/dev/pi-lens/scripts/ci-verdict.mjs 1",
	// review round 2 F5: a payload that MENTIONS "clients/" without
	// actually loading it (the orchestrator's doc-patching idiom) must
	// allow -- only an actual require(/import(/from load specifier denies.
	"node -e \"console.log('note: see clients/ for the service list')\"",
	// review round 3 V1 (LX-6-2), through the real CLI: the exact minimal
	// reproduction the round 2 verify filed -- one unbalanced ")" in a
	// quoted heredoc body used to close the enclosing $( ) span early and
	// leak the rest of the document into the top-level scan.
	"gh pr create --body \"$(cat <<'EOF'\nsmiley :) here\nwe never run `git stash`\nEOF\n)\"",
	// review round 3 (LX-10-1), through the real CLI: a `#` comment.
	"echo hi # $(git stash)",
	// W2 (#2726): real bash does not execute an unclosed substitution in an
	// unquoted heredoc body, but it does continue with a later live command.
	"cat <<EOF\n$(git stash\nEOF\ngit diff",
	"cat <<EOF\n`git stash\nEOF\ngit diff",
	// Real bash reports the malformed outer substitution and does not run a
	// nested substitution inside it.
	"cat <<EOF\n$(echo x\n$(git stash)\nEOF",
	// #3026: the COMPLIANT shapes of the tmpdirCollision rule. TMPDIR aimed
	// at its own directory, with PI_LENS_HOME still pinned at .probe-home
	// exactly as AGENTS.md "Probe hygiene" prescribes.
	"PI_LENS_HOME=$PWD/.probe-home TMPDIR=$PWD/.tmp-disk npx vitest run tests/config",
	"export TMPDIR=/home/dev/.cache/lane-tmp\nnpx vitest run tests/config",
	// TMPDIR untouched -- the harness keeps the real one on purpose.
	"PI_LENS_HOME=$PWD/.probe-home npx vitest run tests/config",
	// A neighbouring directory whose NAME merely starts with the harness
	// segment is a different directory (segment equality, not prefix).
	"TMPDIR=$PWD/.probe-home-2 npm test",
	// PI_LENS_HOME itself pointed at .probe-home is the PRESCRIBED form and
	// must never be caught by the TMPDIR rule.
	"PI_LENS_HOME=$PWD/.probe-home npm test",
	"export PI_LENS_HOME=$PWD/.probe-home && npm test",
	// Review round 2 T3: a DIFFERENT variable whose name merely starts with
	// PI_LENS_HOME names a different directory. Both were denied before the
	// name boundary landed.
	"TMPDIR=$PI_LENS_HOME_TMP npm test",
	"TMPDIR=$PI_LENS_HOMEDIR/x npm test",
	// Review round 2, named limit: a third variable hides the path from a
	// static scan, so this ALLOWS. The row exists so the limit is a pinned,
	// visible behaviour rather than an untested claim in a docblock.
	"export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME; npm test",
];

// Round-2 survey harness retained as a regression fixture for #2705. The
// synthetic 2026-09-07 corpus is above; the real transcript corpus below is
// `tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json`, extracted
// from this project's Claude Code session transcripts on 2026-09-06..08 with
// secrets and the maintainer's email scrubbed. The fixture is data under
// tests/fixtures, so test-file sweeps do not walk it as executable code.
const SURVEY_CORPUS_DATE = "2026-09-07";
const SURVEY_CORPUS = [
	...DENY_CASES.map(([command]) => ({ command, expected: "deny" as const })),
	...ALLOW_CASES.map((command) => ({ command, expected: "allow" as const })),
];

const TRANSCRIPT_CORPUS = JSON.parse(
	readFileSync(
		join(
			repoRoot,
			"tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json",
		),
		"utf8",
	),
) as Array<{ command: string; firstSeen: string }>;

const TRANSCRIPT_CORPUS_DATE = "2026-09-07..08";

function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex");
}

// These are the only two commands in the 2026-09-07..08 transcript corpus
// that exercise a guard rule. Keep this allowlist independent of findDeny so
// a rule widening cannot silently turn a false positive into an expectation.
const EXPECTED_TRANSCRIPT_DENIES = new Set([
	"21def4efd19e12fd4fcb3f0cfcbc7f000814ed54d6ecdb39701e74b08288811f",
	"30b1b57e56ca162793f411ef91bc8e47607a91f420039b3e00451ecd5278ea02",
]);

describe("scripts/hooks/guard-bash.mjs -- deny list (#2699)", () => {
	it.each(DENY_CASES)("denies %j", (command, ruleNeedle) => {
		const result = runHook(command);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain(ruleNeedle);
	});
});

describe("scripts/hooks/guard-bash.mjs -- allow list (#2699)", () => {
	it.each(ALLOW_CASES)("allows %j", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});

describe("scripts/hooks/guard-bash.mjs -- rule declarations (review round 2 T1)", () => {
	it("declares tmpdirCollision in the DenyRule union the .d.mts exports", () => {
		// The union in scripts/hooks/guard-bash.d.mts is what every .ts caller
		// sees. It shipped without the fifth rule in round 1, so this typed
		// binding is the guard: remove "tmpdirCollision" from the union and
		// `npm run lint` fails with TS2322 before the suite even runs.
		const rule: DenyRule = "tmpdirCollision";
		expect(RULE_MESSAGES[rule]).toContain("TMPDIR");
	});

	it("declares worktreeSymlink in the DenyRule union the .d.mts exports", () => {
		// Same guard as the tmpdirCollision case above, for the sixth rule
		// (#3173): remove "worktreeSymlink" from the union and `npm run lint`
		// fails with TS2322 before the suite even runs.
		const rule: DenyRule = "worktreeSymlink";
		expect(RULE_MESSAGES[rule]).toContain("node_modules");
	});
});

// #3173 (twice on 2026-09-16): a fixer ran `git worktree remove` on a tree
// whose node_modules was a symlink into the shared checkout
// (`ln -s <main checkout>/node_modules node_modules`, the fixer playbook's
// own speed convention). Git followed the link and emptied the SHARED
// install; any other agent building or testing in that window saw spurious
// ERR_MODULE_NOT_FOUND. This is a real filesystem check (not pure text
// classification like every other rule above), so each case builds a real
// fixture directory rather than a fictitious path string.
describe("scripts/hooks/guard-bash.mjs -- git worktree remove node_modules symlink hazard (#3173)", () => {
	// A linked git worktree's top-level .git is a FILE containing
	// "gitdir: ..." (never a directory -- that is the main checkout). This
	// is the only thing {@link looksLikeGitWorktree} checks; the content
	// need not resolve to a real repository for the classifier to accept it.
	function makeWorktreeDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		writeFileSync(
			join(dir, ".git"),
			"gitdir: /some/main/checkout/.git/worktrees/fixture\n",
		);
		return dir;
	}

	it("denies git worktree remove on a tree whose node_modules is a symlink OUTSIDE it", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("worktree");
			// The note names the fix (acceptance #1).
			expect(result.stderr).toContain(`rm <tree>/node_modules`);
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("allows the SAME tree once node_modules is unlinked (the note's own prescribed fix)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-");
		const nodeModules = join(tree, "node_modules");
		symlinkSync(shared, nodeModules);
		unlinkSync(nodeModules);
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("allows a tree with a REAL node_modules directory (not a symlink)", () => {
		const tree = makeWorktreeDir("guard-bash-worktree-real-nm-");
		mkdirSync(join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("allows a symlinked node_modules whose target stays INSIDE the worktree (only an OUTSIDE target is the hazard)", () => {
		const tree = makeWorktreeDir("guard-bash-worktree-inside-symlink-");
		const realInside = join(tree, "vendor", "node_modules");
		mkdirSync(dirname(realInside), { recursive: true });
		mkdirSync(realInside);
		symlinkSync(realInside, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("allows a git worktree remove on a path that does not exist -- left to git, no false deny", () => {
		const doesNotExist = join(
			tmpdir(),
			"guard-bash-worktree-does-not-exist-3173",
		);
		const result = runHook(`git worktree remove ${doesNotExist}`);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("allows a git worktree remove on an ordinary directory that is NOT a git worktree, even with a hazard-shaped symlink", () => {
		// Same symlink-outside shape as the deny case above, but with no .git
		// file at all -- looksLikeGitWorktree must gate BEFORE the symlink
		// check runs, or an ordinary directory that merely contains a
		// "node_modules" symlink (e.g. a project's own dependency symlink)
		// would be denied.
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const dir = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-not-a-worktree-"),
		);
		symlinkSync(shared, join(dir, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${dir}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("still detects git worktree remove embedded in a chained command (&&, ;)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-chained-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const chainedAnd = runHook(`cd /tmp && git worktree remove ${tree}`);
			expect(chainedAnd.status).toBe(2);
			expect(chainedAnd.stderr.toLowerCase()).toContain("worktree");

			const chainedSemi = runHook(`echo hi; git worktree remove ${tree}`);
			expect(chainedSemi.status).toBe(2);
			expect(chainedSemi.stderr.toLowerCase()).toContain("worktree");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("still denies with a single --force (this rule is not gated by the double-force worktreeForce rule)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-force-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove --force ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("worktree");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});
});

describe("scripts/hooks/guard-bash.mjs -- ambient PI_LENS_HOME (#2699)", () => {
	it("allows an unpinned-looking node probe when PI_LENS_HOME is only in process.env, not the command text", () => {
		const result = runHook("node -e \"require('./clients/foo.js')\"", {
			...BASE_ENV,
			PI_LENS_HOME: "/some/probe/home",
		});
		expect(result.status).toBe(0);
	});
});

describe("scripts/hooks/guard-bash.mjs -- round-2 survey corpus (#2705)", () => {
	it.each(SURVEY_CORPUS)(
		`keeps the ${SURVEY_CORPUS_DATE} corpus free of non-rule denies: $command`,
		({ command, expected }) => {
			const result = runHook(command);
			if (expected === "allow") {
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			} else {
				expect(result.status, command).toBe(2);
				expect(result.stderr.toLowerCase(), command).toMatch(
					/stash|reset|worktree|probe|tmpdir/,
				);
			}
		},
	);
});

describe(`scripts/hooks/guard-bash.mjs -- transcript corpus ${TRANSCRIPT_CORPUS_DATE} (#2705)`, () => {
	it("keeps the transcript corpus at zero non-rule denies", () => {
		const started = performance.now();
		const offenses: string[] = [];
		let actualDenies = 0;

		for (const { command } of TRANSCRIPT_CORPUS) {
			const result = runHook(command);
			const hash = commandHash(command);
			const expectedDeny = EXPECTED_TRANSCRIPT_DENIES.has(hash);
			if (result.status === 2) actualDenies++;

			if (expectedDeny) {
				if (result.status !== 2)
					offenses.push(`expected deny was allowed: ${command}`);
				continue;
			}
			if (result.status !== 0)
				offenses.push(`non-rule deny (${result.status}): ${command}`);
			else if (result.stderr !== "")
				offenses.push(`unexpected stderr: ${command}`);
		}

		const elapsedMs = performance.now() - started;
		console.log(
			`guard-bash transcript corpus: ${TRANSCRIPT_CORPUS.length} rows, ` +
				`${actualDenies} expected denies, ${Math.round(elapsedMs)}ms`,
		);
		expect(elapsedMs).toBeLessThan(180_000);
		expect(actualDenies).toBe(EXPECTED_TRANSCRIPT_DENIES.size);
		expect(offenses).toEqual([]);
	}, 180_000);
});

describe("scripts/hooks/guard-bash.mjs -- never throws (#2699)", () => {
	it("exits 0 on malformed JSON on stdin", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "not json {{{",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 on empty stdin", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input is missing entirely", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ tool_name: "Bash" }),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input is an empty object", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input.command is not a string", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: 12345 },
			}),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 for a non-Bash tool even with a denied command string", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({
				tool_name: "Edit",
				tool_input: { command: "git stash" },
			}),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	}, 180_000);
});

// #3089: readStdin drains fd 0 to EOF instead of a single readFileSync(0)
// call. Measured on this host: spawnSync's `input` option pumps the
// child's stdin pipe non-blocking while its own synchronous event loop
// feeds it, so a `read(2)` issued before the next chunk has landed can
// throw EAGAIN -- reproducible from ~500 KB of JSON payload, reliably at
// the 1 MB+ sizes below. Pre-fix, `readFileSync(0, "utf8")` does not retry
// that EAGAIN; the throw was swallowed by readStdin's own catch-all,
// producing "no payload" for a payload that was still arriving, and the
// hook failed OPEN (exit 0) on a command it would otherwise have denied.
// This is the real script (HOOK, spawned exactly as runHook() above does)
// over a real OS pipe (spawnSync's own child stdio pipe) -- not a hand-fed
// classifyPayload() call, which never touches readStdin at all.
describe("scripts/hooks/guard-bash.mjs -- drains stdin to EOF on a large payload (#3089)", () => {
	function payloadOfAtLeast(bytes: number, tailCommand: string): string {
		const pad = "x".repeat(bytes);
		return `echo ${pad} && ${tailCommand}`;
	}

	it.each([
		["~500 KB", 500_000],
		["1 MB", 1_000_000],
		["2 MB", 2_000_000],
		["9 MB", 9_000_000],
	])(
		"still denies a %s payload (a single readFileSync(0) fails open here)",
		(_label, bytes) => {
			const command = payloadOfAtLeast(bytes, "git stash");
			const result = runHook(command);
			expect(result.status, `payload length ${command.length}`).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("stash");
		},
		// review round 2 F1: no explicit timeout inherits vitest's 5000ms
		// default (vitest.config.ts sets hookTimeout, not testTimeout), which
		// the 2 MB/9 MB cases blow through under Stryker's dry run -- Stryker
		// then aborts before mutating this PR's own file. The file's own
		// convention for a real spawn this size is 180_000 (see :391, :453).
		60_000,
	);

	// The never-throws contract from #2699 is unchanged by the drain loop:
	// a read error or a genuinely empty stream is still "no payload", not a
	// crash and not a deny.
	it("still exits 0 on a genuinely empty stream", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("still exits 0 on a genuine read error (EBADF, not EAGAIN) -- and notes it (#3089 review round 2 F2/F3)", () => {
		// review round 2 F2: stdio: "ignore" hands the child /dev/null, which
		// reads 0 bytes cleanly -- the same EOF branch as the empty-stream
		// case above, never reaching readStdin's `throw error` at :1079-ish.
		// A WRITE-ONLY fd handed to the child as fd 0 instead produces a
		// GENUINE EBADF on the child's first read(2) (probed directly:
		// fs.readSync on a write-only fd throws
		// "EBADF: bad file descriptor, read"), which is the branch that
		// mutation-tests `throw error` -- reverting it to `break` would
		// silently fold this case into the empty-stream case (chunks stays
		// [], "" is returned instead of the error propagating), losing the
		// note asserted below.
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-ebadf-"));
		const writeOnlyFile = join(dir, "write-only");
		const writeOnlyFd = openSync(writeOnlyFile, "w");
		try {
			const result = spawnSync(process.execPath, [HOOK], {
				stdio: [writeOnlyFd, "pipe", "pipe"],
				encoding: "utf8",
				env: BASE_ENV,
			});
			expect(result.status).toBe(0);
			// review round 2 F3: a genuine read error is a FAILURE, not an
			// ordinary "nothing to check" allow -- unlike the true-empty-
			// stream case above, it is noted so the hook's own stderr says
			// why nothing was checked instead of looking identical to every
			// other allow. review round 3 N1: the note names the actual
			// cause (error.code, EBADF here) via the crash guard's shared
			// template -- NOT the JSON.parse-only "unreadable or
			// unparseable" wording, which this path never reaches (readStdin
			// throws before run() ever gets to `raw.trim()` or JSON.parse).
			expect(result.stderr).toBe(
				"guard-bash: EBADF while checking payload; allowing\n",
			);
		} finally {
			closeSync(writeOnlyFd);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// #3089 review round 2 F3: the JSON.parse failure path is the OTHER
	// "saw real input, failed to make sense of it" failure (distinct from
	// the read-error case above) -- a payload cut off mid-document, the
	// literal shape a short read produces. Built directly (sliced valid
	// JSON) rather than raced through spawnSync's own EAGAIN timing, so the
	// truncation point is deterministic.
	it("notes an unparseable (truncated) payload instead of allowing silently", () => {
		const fullPayload = JSON.stringify({
			session_id: "probe",
			cwd: repoRoot,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: `echo ${"x".repeat(1_000_000)} && git stash` },
		});
		const truncated = fullPayload.slice(0, 500_105);
		expect(truncated.length).toBeLessThan(fullPayload.length);
		expect(() => JSON.parse(truncated)).toThrow();
		const result = spawnSync(process.execPath, [HOOK], {
			input: truncated,
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe(
			"guard-bash: payload unreadable or unparseable; allowing\n",
		);
	});

	// #3089 review round 3 N2: the note() write itself must never be the
	// thing that turns an intended exit-0 allow into an uncaught-exception
	// exit 1. A read-only fd handed to the child as stderr reproduces this:
	// the crash-guard path (forced here via the same depth-5000 nesting
	// that crashes the tokenizer, a real command containing `git stash`)
	// tries to note the failure, that write itself fails, and pre-fix that
	// second failure was unguarded.
	it("still exits 0 (not 1) when the crash-guard's own note write fails (read-only stderr fd)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-stderr-ro-"));
		const readOnlyFile = join(dir, "stderr-ro");
		writeFileSync(readOnlyFile, "");
		const readOnlyFd = openSync(readOnlyFile, "r");
		try {
			const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
			const result = spawnSync(process.execPath, [HOOK], {
				input: JSON.stringify({
					session_id: "probe",
					cwd: repoRoot,
					permission_mode: "default",
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command: `echo ${deep}` },
				}),
				stdio: ["pipe", "pipe", readOnlyFd],
				encoding: "utf8",
				env: BASE_ENV,
			});
			// Pre-fix (`try { process.stderr.write(text) } catch {}` alone):
			// exit 1, an uncaught 'error' event from the Writable stream's
			// own async I/O failure, which a synchronous try/catch around
			// process.stderr.write cannot catch -- confirmed exit 1 in that
			// configuration. Post-fix (fs.writeSync, which throws EBADF
			// synchronously for this same fd): exit 0.
			expect(result.status).toBe(0);
		} finally {
			closeSync(readOnlyFd);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// #3089 review trailing round (#3121): the ALLOW-path notes (round 2/3)
// were mutation-tested against a broken stderr; the DENY path's OWN write
// -- `note(`${RULE_MESSAGES[rule]}\n`)` -- never was. Reverting just that
// one call site to `process.stderr.write` (note() itself untouched) keeps
// every prior test in this file green (none of them deny through a broken
// stderr) while reintroducing exactly #3121's bug: a `git stash` a caller
// asked to have denied gets ALLOWED (exit 1, an uncaught exception, not
// exit 2) whenever stderr happens to be unwritable. The verdict (deny) and
// the message (why) are two different guarantees; only the message may be
// lost to a broken stderr, never the verdict.
describe("scripts/hooks/guard-bash.mjs -- deny verdict survives a broken stderr (#3121)", () => {
	const DENY_RULE_COMMANDS: Array<[rule: string, command: string]> = [
		["stash", "git stash"],
		["reset", "git reset --hard HEAD"],
		["worktree", "git worktree remove -f -f /tmp/tree"],
		[
			"tmpdirCollision",
			"TMPDIR=$PWD/.probe-home npx vitest run tests/clients/ext-gate-before-ignore.test.ts",
		],
		["probe", "node -e \"require('./clients/foo.js')\""],
	];

	it.each(DENY_RULE_COMMANDS)(
		"still denies (%s) when stderr is a read-only fd -- message lost, verdict kept",
		(_rule, command) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-deny-ro-"));
			const readOnlyFile = join(dir, "stderr-ro");
			writeFileSync(readOnlyFile, "");
			const readOnlyFd = openSync(readOnlyFile, "r");
			try {
				const result = spawnSync(process.execPath, [HOOK], {
					input: JSON.stringify({
						session_id: "probe",
						cwd: repoRoot,
						permission_mode: "default",
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: { command },
					}),
					stdio: ["pipe", "pipe", readOnlyFd],
					encoding: "utf8",
					env: BASE_ENV,
				});
				expect(result.status).toBe(2);
			} finally {
				closeSync(readOnlyFd);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("scripts/hooks/guard-bash.mjs -- registration (review round 2 F3)", () => {
	it(".claude/settings.json's PreToolUse Bash hook does not start with a relative path", () => {
		const settings = JSON.parse(
			readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
		);
		const entry = settings.hooks.PreToolUse[0];
		expect(entry.matcher).toBe("Bash");
		const command: string = entry.hooks[0].command;
		// A relative "node scripts/hooks/guard-bash.mjs" resolves against the
		// hook's cwd, which follows Claude into a worktree that predates this
		// file -- ERR_MODULE_NOT_FOUND on every Bash call, no enforcement.
		// ${CLAUDE_PROJECT_DIR} stays pinned to the session-start root
		// regardless of a later worktree cd (the hooks doc's own recommended
		// fix for exactly this).
		expect(command).toContain("${CLAUDE_PROJECT_DIR}");
		expect(/^node\s+scripts\//.test(command)).toBe(false);
		expect(command.includes("scripts/hooks/guard-bash.mjs")).toBe(true);
	});
});

describe("scripts/hooks/guard-bash.mjs -- tokenizer unit behavior (#2699)", () => {
	it("treats a quoted command word as opaque text, not a live command boundary", () => {
		expect(findDeny('echo "git stash"')).toBeNull();
		expect(findDeny("echo 'git stash'")).toBeNull();
	});

	it("splits on &&, ||, ;, |, and newline at the top level", () => {
		expect(findDeny("echo hi && git stash")).toBe("stash");
		expect(findDeny("echo hi || git stash")).toBe("stash");
		expect(findDeny("echo hi ; git stash")).toBe("stash");
		expect(findDeny("echo hi\ngit stash")).toBe("stash");
	});

	it("strips leading env assignments before finding the command word", () => {
		const { env, rest } = stripEnvAssignments([
			"FOO=bar",
			"BAZ=qux",
			"git",
			"stash",
		]);
		expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
		expect(rest).toEqual(["git", "stash"]);
	});

	it("scannableRegions returns the top level first, then every substitution body, flattened", () => {
		expect(scannableRegions("echo $(git stash) `git log`")).toEqual([
			"echo  ",
			"git stash",
			"git log",
		]);
		// Flattened at ANY depth -- round 2 recursed with a depth cap of 8,
		// which silently ALLOWED anything nested deeper.
		expect(scannableRegions("echo $(echo $(echo $(git stash)))")).toEqual([
			"echo ",
			"git stash",
			"echo ",
			"echo ",
		]);
	});

	it("splitSegments splits the retained text on every metacharacter", () => {
		expect(splitSegments("a && b || c ; d | e & f\ng")).toEqual([
			"a ",
			" b ",
			" c ",
			" d ",
			" e ",
			" f",
			"g",
		]);
	});

	it("classifyPayload allows a Read tool call carrying a denied-looking command field", () => {
		expect(
			classifyPayload({
				tool_name: "Read",
				tool_input: { command: "git stash" },
			}),
		).toBeNull();
	});

	it("splitWords fuses a quoted span into one opaque word", () => {
		expect(splitWords('echo "git stash"')).toEqual(["echo", "git stash"]);
	});

	it("(review round 2 F1) drops a QUOTED-delimiter heredoc body -- its backtick span is never collected as a substitution", () => {
		const regions = scannableRegions(
			"cat <<'EOF'\nmentions `git stash` here\nEOF",
		);
		// Only the top level survives; no substitution region was produced.
		expect(regions).toHaveLength(1);
		// The command's own text ("cat <<'EOF'") survives; the body does not.
		expect(regions[0]).not.toContain("git stash");
	});

	it("(review round 2 F1) a heredoc nested inside a $() subshell still drops its own body", () => {
		expect(
			findDeny("gh pr create --body \"$(cat <<'EOF'\n`git stash`\nEOF\n)\""),
		).toBeNull();
	});

	it("(review round 2 F7) a command word is resolved by its final path segment", () => {
		expect(findDeny("/usr/bin/git stash")).toBe("stash");
		expect(findDeny("./git stash")).toBe("stash");
	});
});

describe("scripts/hooks/guard-bash.mjs -- cross-segment export tracking (review round 2 F2)", () => {
	// Spawned (not a direct findDeny() call): the PI_LENS_HOME-absence branch
	// reads real process.env, so an in-process call would inherit whatever
	// this test RUNNER's own environment carries (this repo's own probe-
	// hygiene convention sets PI_LENS_HOME for ad-hoc probes) -- exactly the
	// ambient-leakage BASE_ENV exists to prevent for the spawned cases below.
	it("a bare (non-export) prefix on an earlier segment does not leak to a later segment's node call", () => {
		const result = runHook(
			"PI_LENS_HOME=/x true; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain("probe");
	});

	it("export on an earlier segment DOES reach a later segment's node call", () => {
		const result = runHook(
			"export PI_LENS_HOME=/x; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});

	it("a standalone (non-exported) VAR=val segment with no command also persists forward (lenient)", () => {
		const result = runHook(
			"PI_LENS_HOME=/x; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});

	it("`export FOO=bar node ...` on ONE segment never runs node at all (real bash: export takes only names/assignments, never a trailing command)", () => {
		// Deliberately NOT PI_LENS_HOME: if `export`'s trailing words were
		// (wrongly) treated as a command to classify, this would misread
		// "node" as the command and (with no PI_LENS_HOME anywhere) deny it.
		// Real bash never runs "node" here at all -- "node" is just another
		// bare name `export` marks, so nothing executes and this allows.
		const result = runHook(
			"export SOME_OTHER_VAR=/x node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Lexer state space (review round 3)
// ---------------------------------------------------------------------------
//
// Round 2's verify found a NEW defect on the seam round 2 built (V1: a
// `$( … )` span delimited by a paren counter that ran THROUGH heredoc
// bodies), so this round enumerates the seam's whole axis instead of
// patching the case that was reported: (region kind) × (nesting context),
// 11 rows × 5 columns. Row/column ids match the table in the PR body.
//
// Every `expect` value below is EMPIRICAL. Each command was run through
// real `bash -c` with the forbidden command rewritten to `touch <marker>`,
// and the expectation is whether the marker FILE appeared -- so a `cat`
// that merely PRINTS a heredoc body cannot be mistaken for one that
// executes it. All 58 agreed with real bash (transcript in the PR body);
// an earlier pass that grepped stdout for a printed marker instead was
// wrong on six cells, which is why the side-effect form is the one that
// ships.
//
// Driven through the exported `findDeny` rather than a spawned process:
// the subject here is the LEXER, and 58 more child processes would add ~2s
// of wall clock to a suite whose CLI contract is already pinned by the 90+
// spawned cases above (the four headline cells -- V1, V3a, V2, the comment
// region -- are additionally spawned in DENY_CASES/ALLOW_CASES). No case
// in this table can reach the probe rule, so none of them reads
// `process.env`.
const S = "git stash";

type LexerCell = {
	id: string;
	cell: string;
	command: string;
	expect: "deny" | "allow";
};

const LEXER_STATE_SPACE: LexerCell[] = [
	// R1 -- top-level text (a bare simple command)
	{
		id: "LX-1-1",
		cell: "R1/C1 a bare simple command",
		command: S,
		expect: "deny",
	},
	{
		id: "LX-1-2",
		cell: "R1/C2 command inside $( )",
		command: `echo $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-1-3",
		cell: "R1/C3 command inside backticks",
		command: `echo \`${S}\``,
		expect: "deny",
	},
	{
		id: "LX-1-4",
		cell: "R1/C4 plain body text is data, never a command",
		command: `cat <<EOF\n${S}\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-1-5",
		cell: "R1/C5 command text in double quotes is one opaque word",
		command: `echo "${S}"`,
		expect: "allow",
	},

	// R2 -- double-quoted span
	{
		id: "LX-2-1",
		cell: "R2/C1 a double-quoted span fuses into the surrounding word",
		command: `git "stash"`,
		expect: "deny",
	},
	{
		id: "LX-2-1b",
		cell: "R2/C1 an ESCAPED double quote outside quotes must not open a quote region and swallow the separator",
		command: `echo a\\" ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-2-2",
		cell: "R2/C2 same, inside $( )",
		command: `echo $(git "stash")`,
		expect: "deny",
	},
	{
		id: "LX-2-3",
		cell: "R2/C3 same, inside backticks",
		command: 'echo `git "stash"`',
		expect: "deny",
	},
	{
		id: "LX-2-4",
		cell: "R2/C4 quotes are LITERAL in a body; the $( ) inside still runs",
		command: `cat <<EOF\n"$(${S})"\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-2-5",
		cell: "R2/C5 an escaped quote inside double quotes stays literal",
		command: `echo "he said \\"${S}\\""`,
		expect: "allow",
	},
	{
		id: "LX-2-5b",
		cell: "R2/C5 an escaped $ inside double quotes is not a substitution",
		command: `echo "\\$(${S})"`,
		expect: "allow",
	},
	{
		id: "LX-2-5c",
		cell: "R2/C5 an escaped backtick inside double quotes is not a substitution",
		command: `echo "\\\`${S}\\\`"`,
		expect: "allow",
	},

	// R3 -- single-quoted span
	{
		id: "LX-3-1",
		cell: "R3/C1 no expansion inside single quotes",
		command: `echo '$(${S})'`,
		expect: "allow",
	},
	{
		id: "LX-3-1b",
		cell: "R3/C1 a single-quoted span still forms the WORD (must not be deleted)",
		command: `git 'stash'`,
		expect: "deny",
	},
	{
		id: "LX-3-1c",
		cell: "R3/C1 an ESCAPED single quote outside quotes must not open a quote region and swallow the separator",
		command: `echo a\\' ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-3-1d",
		cell: "R3/C1 …nor hide LIVE syntax after it -- the region pass's own quote state, not just the segment splitter's",
		command: `echo a\\' $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-3-2",
		cell: "R3/C2 same, inside $( )",
		command: `echo $(echo '$(${S})')`,
		expect: "allow",
	},
	{
		id: "LX-3-3",
		cell: "R3/C3 same, inside backticks",
		command: `echo \`echo '$(${S})'\``,
		expect: "allow",
	},
	{
		id: "LX-3-4",
		cell: "R3/C4 single quotes are LITERAL in a body; the $( ) still runs",
		command: `cat <<EOF\n'$(${S})'\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-3-5",
		cell: "R3/C5 an apostrophe in double quotes must not open a quote region",
		command: `echo "it's $(${S})"`,
		expect: "deny",
	},

	// R4 -- backtick span
	{
		id: "LX-4-1",
		cell: "R4/C1 a backtick span closes; text after it is still scanned",
		command: `echo \`date\`; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-4-2",
		cell: "R4/C2 backtick span inside $( )",
		command: `echo $(echo \`${S}\`)`,
		expect: "deny",
	},
	{
		id: "LX-4-3",
		cell: "R4/C3 a backslash-escaped backtick span nested in a backtick span",
		command: `echo \`echo \\\`${S}\\\`\``,
		expect: "deny",
	},
	{
		id: "LX-4-4",
		cell: "R4/C4 backtick substitution inside an unquoted-delimiter body",
		command: `cat <<EOF\n\`${S}\`\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-4-5",
		cell: "R4/C5 backtick span inside double quotes",
		command: `echo "\`${S}\`"`,
		expect: "deny",
	},

	// R5 -- $( ) span
	{
		id: "LX-5-1",
		cell: "R5/C1 a ) inside quotes must not close the span early",
		command: `echo $(echo ')') ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-5-1b",
		cell: "R5/C1 plain nested ( ) must not close the span early -- with the enclosing double quotes, a truncated span leaves the rest as ONE quoted word",
		command: `echo "$( (echo a) ; ${S} )"`,
		expect: "deny",
	},
	{
		id: "LX-5-2",
		cell: "R5/C2 nested $( )",
		command: `echo $(echo $(${S}))`,
		expect: "deny",
	},
	{
		id: "LX-5-3",
		cell: "R5/C3 $( ) inside backticks",
		command: `echo \`echo $(${S})\``,
		expect: "deny",
	},
	{
		id: "LX-5-4",
		cell: "R5/C4 V3a -- $( ) in an unquoted-delimiter body really runs",
		command: `cat <<EOF\n$(${S})\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-5-5",
		cell: "R5/C5 $( ) inside double quotes",
		command: `echo "$(${S})"`,
		expect: "deny",
	},

	// R6 -- heredoc body, QUOTED delimiter
	{
		id: "LX-6-1",
		cell: "R6/C1 a quoted-delimiter body is inert in full",
		command: `cat <<'EOF'\n$(${S})\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-6-2",
		cell: "R6/C2 V1 -- an unbalanced ) in a quoted body must not close the enclosing $( )",
		command: `gh pr create --body "$(cat <<'EOF'\nsmiley :) here\nwe never run \`${S}\`\nEOF\n)"`,
		expect: "allow",
	},
	{
		id: "LX-6-3",
		cell: "R6/C3 a quoted-delimiter heredoc inside a backtick span",
		command: `echo \`cat <<'EOF'\n$(${S})\nEOF\n\``,
		expect: "allow",
	},
	{
		id: "LX-6-4",
		cell: "R6/C4 a << operator inside a body is literal text",
		command: `cat <<'EOF'\ncat <<'X'\n${S}\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-6-5",
		cell: "R6/C5 a << inside double quotes NEVER starts a heredoc",
		command: `echo "cat <<'EOF'"; ${S}`,
		expect: "deny",
	},

	// R7 -- heredoc body, UNQUOTED delimiter
	{
		id: "LX-7-1",
		cell: "R7/C1 unquoted-delimiter body text with no substitution is inert",
		command: `cat <<EOF\nmentions ${S} here\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-7-2",
		cell: "R7/C2 unquoted-delimiter body inside $( )",
		command: `gh pr create --body "$(cat <<EOF\n$(${S})\nEOF\n)"`,
		expect: "deny",
	},
	{
		id: "LX-7-3",
		cell: "R7/C3 unquoted-delimiter body inside backticks",
		command: `echo \`cat <<EOF\n$(${S})\nEOF\n\``,
		expect: "deny",
	},
	{
		id: "LX-7-4",
		cell: "R7/C4 a nested << inside an unquoted body is literal",
		command: `cat <<EOF\ncat <<'X'\n${S}\nX\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-7-5",
		cell: "R7/C5 unquoted-delimiter body inside double quotes",
		command: `echo "$(cat <<EOF\n$(${S})\nEOF\n)"`,
		expect: "deny",
	},

	// R8 -- <<- tab-stripped body
	{
		id: "LX-8-1",
		cell: "R8/C1 V2 -- <<- strips leading tabs before matching the delimiter",
		command: `cat <<-EOF\n\tbody\n\tEOF\n${S}`,
		expect: "deny",
	},
	{
		id: "LX-8-2",
		cell: "R8/C2 <<-'EOF' body inside $( ) is inert",
		command: `gh pr create --body "$(cat <<-'EOF'\n\tmentions ${S}\n\tEOF\n)"`,
		expect: "allow",
	},
	{
		id: "LX-8-3",
		cell: "R8/C3 <<-EOF body substitution inside backticks",
		command: `echo \`cat <<-EOF\n\t$(${S})\n\tEOF\n\``,
		expect: "deny",
	},
	{
		id: "LX-8-4",
		cell: "R8/C4 a quoted <<- delimiter drops substitutions",
		command: `cat <<-'EOF'\n\t$(${S})\n\tEOF`,
		expect: "allow",
	},
	{
		id: "LX-8-5",
		cell: "R8/C5 <<-EOF body substitution inside double quotes",
		command: `echo "$(cat <<-EOF\n\t$(${S})\n\tEOF\n)"`,
		expect: "deny",
	},

	// R9 -- here-string <<<
	{
		id: "LX-9-1",
		cell: "R9/C1 here-string content is data",
		command: `cat <<< "${S}"`,
		expect: "allow",
	},
	{
		id: "LX-9-1b",
		cell: "R9/C1 a substitution in a here-string IS live",
		command: `cat <<< $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-9-2",
		cell: "R9/C2 here-string inside $( )",
		command: `echo $(cat <<< "${S}")`,
		expect: "allow",
	},
	{
		id: "LX-9-3",
		cell: "R9/C3 here-string inside backticks",
		command: `echo \`cat <<< "${S}"\``,
		expect: "allow",
	},
	{
		id: "LX-9-4",
		cell: "R9/C4 a <<< inside a heredoc body is literal",
		command: `cat <<EOF\ncat <<< "${S}"\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-9-5",
		cell: "R9/C5 <<< must not read as << with delimiter <",
		command: `cat <<< "hi"; ${S}`,
		expect: "deny",
	},

	// R10 -- comment
	{
		id: "LX-10-1",
		cell: "R10/C1 a comment hides a substitution",
		command: `echo hi # $(${S})`,
		expect: "allow",
	},
	{
		id: "LX-10-1b",
		cell: "R10/C1 a # mid-word is NOT a comment",
		command: `echo a#b; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-10-2",
		cell: "R10/C2 comment inside $( )",
		command: `echo $(echo hi # $(${S})\n)`,
		expect: "allow",
	},
	{
		id: "LX-10-3",
		cell: "R10/C3 comment inside backticks",
		command: `echo \`echo hi # $(${S})\n\``,
		expect: "allow",
	},
	{
		id: "LX-10-4",
		cell: "R10/C4 # is NOT a comment in a heredoc body",
		command: `cat <<EOF\n# $(${S})\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-10-5",
		cell: "R10/C5 # inside double quotes is not a comment",
		command: `echo "# hi"; ${S}`,
		expect: "deny",
	},

	// R11 -- backslash-newline continuation
	{
		id: "LX-11-1",
		cell: "R11/C1 backslash-newline splices one command",
		command: "git \\\nstash",
		expect: "deny",
	},
	{
		id: "LX-11-2",
		cell: "R11/C2 splice inside $( )",
		command: "echo $(git \\\nstash)",
		expect: "deny",
	},
	{
		id: "LX-11-3",
		cell: "R11/C3 splice inside backticks",
		command: "echo `git \\\nstash`",
		expect: "deny",
	},
	{
		id: "LX-11-4",
		cell: "R11/C4 splice inside a heredoc body's $( )",
		command: "cat <<EOF\n$(git \\\nstash)\nEOF",
		expect: "deny",
	},
	{
		id: "LX-11-5",
		cell: "R11/C5 splice inside double quotes must not swallow the next command",
		command: `echo "a\\\nb"; ${S}`,
		expect: "deny",
	},
];

describe("scripts/hooks/guard-bash.mjs -- lexer state space (review round 3)", () => {
	it.each(
		LEXER_STATE_SPACE.map((f) => [f.id, f.cell, f.command, f.expect] as const),
	)("%s %s", (_id, _cell, command, expected) => {
		expect(findDeny(command) === null ? "allow" : "deny").toBe(expected);
	});

	it("covers all 55 (region kind × nesting context) cells with no duplicate ids", () => {
		const ids = LEXER_STATE_SPACE.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		// 11 rows × 5 columns, plus 9 same-cell discriminators (LX-2-1b,
		// LX-2-5b, LX-2-5c, LX-3-1b, LX-3-1c, LX-3-1d, LX-5-1b, LX-9-1b,
		// LX-10-1b) that each pin a second behaviour of their own cell.
		expect(ids).toHaveLength(64);
		for (let row = 1; row <= 11; row++)
			for (let col = 1; col <= 5; col++)
				expect(ids).toContain(`LX-${row}-${col}`);
	});
});

describe("scripts/hooks/guard-bash.mjs -- heredoc terminator matching (review round 3 V3b)", () => {
	// A CRLF command text is what a Windows/Git-Bash-shaped tool call
	// carries. Round 2 compared the raw line, so "EOF\r" never equalled
	// "EOF": the body ran to end-of-text and every later command was
	// silently swallowed -- a false ALLOW, the one direction this guard
	// must never fail in.
	it("tolerates a \\r before the delimiter line's newline", () => {
		expect(findDeny("cat <<'EOF'\r\nbody\r\nEOF\r\ngit stash")).toBe("stash");
		expect(findDeny("cat <<-EOF\r\n\tbody\r\n\tEOF\r\ngit stash")).toBe(
			"stash",
		);
	});

	it("strips tabs ONLY for <<-, never for a plain << (the inverse mutation)", () => {
		// Real bash: a TAB-indented "EOF" does not terminate a plain <<
		// heredoc, so `git stash` here is body text and nothing runs. If tabs
		// were stripped unconditionally the body would end early and that
		// line would be read as a live command -- a false DENY.
		expect(findDeny("cat <<EOF\n\tEOF\ngit stash\nEOF")).toBeNull();
		// Control, same shape with <<-: the tab-stripped delimiter DOES
		// terminate, so the line after it is a live command.
		expect(findDeny("cat <<-EOF\n\tEOF\ngit stash")).toBe("stash");
	});

	it("still swallows nothing when the delimiter genuinely never appears", () => {
		// No terminator at all: the body runs to end-of-text, which is what
		// bash does too (it reports an unterminated heredoc and runs nothing).
		expect(findDeny("cat <<'EOF'\ngit stash")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- runner prefixes (review round 3 V5)", () => {
	it("strips sudo and time, which really do run their argument", () => {
		expect(findDeny("sudo git stash")).toBe("stash");
		expect(findDeny("time git stash")).toBe("stash");
		expect(findDeny("sudo time command git stash")).toBe("stash");
	});

	it("does NOT claim to handle a runner prefix carrying its own options", () => {
		// Documented in the script header's NOT-handled block rather than
		// silently believed to work: the option becomes the command word.
		expect(findDeny("sudo -u root git stash")).toBeNull();
		expect(findDeny("timeout 30 git stash")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- unbounded nesting never throws (review round 3)", () => {
	// Round 2 capped substitution recursion at depth 8, which silently
	// ALLOWED anything nested deeper. The cap is deleted; what bounds the
	// pass now is `run`'s own never-throw contract.
	it("allows (exit 0) rather than crashing on pathologically deep nesting", () => {
		const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
		const result = runHook(`echo ${deep}`);
		expect(result.status === 0 || result.status === 2).toBe(true);
		expect(result.status).not.toBe(1);
	});

	it("catches nesting far deeper than round 2's depth cap of 8", () => {
		const deep = `${"$(".repeat(20)}git stash${")".repeat(20)}`;
		expect(findDeny(`echo ${deep}`)).toBe("stash");
	});

	// #3089 review round 3 N1: the depth-5000 case above IS this hook's most
	// important fail-open -- the payload is read and JSON.parse'd perfectly
	// (it contains a real `git stash`, which should have been denied), and
	// ONLY the tokenizer crashes (RangeError: Maximum call stack size
	// exceeded, confirmed directly against classifyPayload on this host).
	// Before this round the crash guard's note claimed the payload was
	// "unreadable or unparseable" -- false; a wrong label on the most
	// important fail-open is worse than the silence it replaced. The note
	// must name the real cause (error.name here, since a RangeError has no
	// .code) instead.
	it("names RangeError, not 'unreadable or unparseable', when the classifier (not the read) crashes", () => {
		const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
		const result = runHook(`echo ${deep}`);
		// Measured on this host (and required by the finding this test
		// pins): depth 5000 deterministically overflows the tokenizer's own
		// recursion, so the crash guard is what's under test, not the
		// tokenizer's variable stack-depth tolerance the sibling test above
		// allows for.
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("RangeError");
		expect(result.stderr).not.toContain("unreadable");
		expect(result.stderr).not.toContain("unparseable");
	});
});
