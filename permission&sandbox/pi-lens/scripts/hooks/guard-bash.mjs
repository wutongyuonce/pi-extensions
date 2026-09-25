#!/usr/bin/env node
/**
 * scripts/hooks/guard-bash.mjs (#2699, refs umbrella #2697)
 *
 * PreToolUse hook for the Bash tool. Mechanically enforces six
 * non-negotiables that previously lived only as prose in CLAUDE.md and the
 * fixer/reviewer playbooks -- a fixer ran `git stash` on 2026-09-07 (the
 * #2686 lane), two review probes wrote into the real `~/.pi-lens` on
 * 2026-09-02 (#2506), a fixer pointed TMPDIR at the vitest harness home
 * on 2026-09-15 (#3026), and twice on 2026-09-16 a fixer ran
 * `git worktree remove` on a tree whose `node_modules` was a symlink into
 * the shared checkout, so git followed the link and emptied the shared
 * install (#3173), all rules a hook can catch that prose could not:
 *
 *   - `git stash` in any form (CLAUDE.md non-negotiable)
 *   - `git reset --soft origin/<branch>` / `git reset --hard <anything>`
 *   - a HAND-typed `git worktree remove` with two force flags (the
 *     sanctioned removal is `node scripts/prune-agent-worktrees.mjs`,
 *     liveness-checked, or unlock + single force)
 *   - ANY `git worktree remove` (force or not) on a worktree whose
 *     `node_modules` is a symlink pointing OUTSIDE that worktree (#3173,
 *     the #2704 class) -- see {@link hasNodeModulesSymlinkOutside}
 *   - an unpinned `node` probe that LOADS built runtime code from clients/
 *     or dist/ (not merely a payload that mentions "clients/" in passing --
 *     review round 2 F5) with no PI_LENS_HOME pin (AGENTS.md "Probe
 *     hygiene")
 *   - `TMPDIR`/`TMP`/`TEMP` aimed at the vitest harness's own home
 *     (AGENTS.md "Probe hygiene", #3026) -- see {@link classifyTempDirVars}
 *
 * ## Contract source
 *
 * Fetched https://code.claude.com/docs/en/hooks (docs.anthropic.com/en/docs/
 * claude-code/hooks 301-redirects there) on 2026-09-07. A PreToolUse hook
 * receives this on stdin:
 *   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
 *     tool_name, tool_input, tool_use_id, ... }
 * For the Bash tool, `tool_input = { command: string, ... }`. A hook denies
 * the call in one of two ways: (a) exit code 2 with the reason written to
 * stderr, or (b) exit 0 and print
 * `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
 * "deny","permissionDecisionReason":"..."}}` to stdout. This script uses
 * (a) -- the issue's own wording ("exit 2 with a one-line teaching message")
 * names it, and it is the simpler of the two to test (one exit code, one
 * stream, no JSON-shape drift risk on stdout).
 *
 * ## Shape: subtract the inert regions, THEN tokenize (review round 3)
 *
 * Round 2 delimited a `$( … )` span with a standalone paren/quote counter
 * that ran THROUGH heredoc bodies. One unbalanced `)` in prose therefore
 * closed the span early and the rest of a PR description leaked into the
 * top-level command scan (round 2's own PR body was denied by its own
 * hook). The lesson is structural, not a missing case: span extents and
 * heredoc bodies cannot be decided by two separate scanners.
 *
 * So there is now exactly ONE region pass, {@link lexRegions}, which is
 * simultaneously quote-, comment-, heredoc- and substitution-aware and
 * calls ITSELF to find a nested span's extent. It returns
 *
 *   - `retained`: the text left after every INERT region is subtracted, and
 *   - a flat list of every command-substitution body at any depth,
 *
 * and only then does {@link splitSegments} split on operators (it has to
 * know about quotes and nothing else, because substitutions, heredoc
 * bodies and comments are already gone). A stray `)`/backtick inside a
 * heredoc body is unreachable by construction rather than special-cased.
 *
 * The regions are classified from REAL bash, empirically -- every
 * (region kind × nesting context) cell of the state space was run through
 * `bash -c` with a side-effecting stand-in for the forbidden command, and
 * the cell's verdict is whether the side effect happened. The full table,
 * with the fixture id that pins each cell, is in the PR body and in
 * `tests/scripts/guard-bash-hook.test.ts`'s `LEXER_STATE_SPACE`. The three
 * results that are easy to get backwards from reading code alone:
 *
 *   - A heredoc body with a QUOTED delimiter (`<<'EOF'`, `<<"EOF"`,
 *     `<<\EOF`) is inert in full and is dropped.
 *   - A heredoc body with an UNQUOTED delimiter (`<<EOF`) is NOT inert:
 *     bash still expands `$( … )` and backticks inside it, so
 *     `cat <<EOF` / `$(git stash)` / `EOF` really runs it. Its body text is
 *     dropped but its substitutions are recursed into.
 *   - Quotes and `#` are LITERAL inside any heredoc body -- so
 *     `'$(git stash)'` and `# $(git stash)` on a body line both still run.
 *
 * A single-quoted span is deliberately NOT subtracted. It is inert for
 * operator splitting, expansion, and comment/heredoc recognition, but it
 * still takes part in WORD formation: `git 'stash'` and `'git' stash` both
 * really run `git stash`. It is retained as literal word text instead, and
 * {@link splitWords} strips the quotes when fusing the word.
 *
 * ## Handled
 *
 * `&&`, `||`, `;`, `|`, `&`, `(`, `)`, newline as segment separators;
 * single/double-quoted spans as opaque fused words; `$( … )` and backtick
 * spans, recursively (including a `\``-escaped backtick span nested inside
 * a backtick span, which bash does execute); `<<`/`<<-` heredocs with a
 * quoted, bare, or backslash-escaped delimiter, `<<-`'s leading-tab strip,
 * and a `\r` before the delimiter's newline (a CRLF command whose
 * terminator would otherwise never match, swallowing every later command);
 * `<<<` here-strings (content inert, substitutions live); `#` comments,
 * recognized only at a word start the way bash does (`a#b` is not a
 * comment); backslash-newline line continuation; a leading `{`
 * command-group brace and `command`/`exec`/`env`/`sudo`/`time` runner
 * prefixes; `export VAR=val` persisted forward to later segments of the
 * same scan; a command word resolved by its final path segment
 * (`/usr/bin/git` == `./git` == `git`); leading `FOO=bar` env assignments
 * and `-c <k>=<v>` / `-C <dir>` git global options; a backslash-escaped
 * command word (`\g\i\t stash`, which bash runs).
 *
 * ## NOT handled (accepted; no test claims otherwise)
 *
 *   - `eval "…"`, `bash -c "…"` / `sh -c "…"`, `xargs git stash`: the
 *     nested string or spawned argv is opaque to any text scan.
 *   - A runner prefix carrying its OWN options -- `sudo -u root git stash`,
 *     `timeout 30 git stash`, `nice -n 10 git stash`, `stdbuf -o0 …`. Only
 *     the bare prefix forms above are stripped; a prefix followed by a
 *     flag stops the search (the flag becomes the command word and matches
 *     no rule).
 *   - A command word assembled by expansion (`git st$(echo a)sh`,
 *     `${G} stash`, `$(which git) stash`): no static text scan can resolve
 *     a runtime-computed word.
 *   - `require(mod)` with a variable specifier, for the probe rule.
 *
 * These are documented blind spots, not silent ones: the guard's threat
 * model is an agent's own slip, not a party deliberately hiding a command
 * from it.
 *
 * Never throws: any stdin/JSON/classification failure degrades to "allow"
 * (exit 0) rather than blocking every Bash call in the session -- a crashed
 * hook must never be the thing that blocks the tool. That is also what
 * bounds recursion: {@link lexRegions} nests once per nested span, and a
 * pathologically deep input raises RangeError, which {@link run} catches
 * and allows. (Round 2 capped nesting at depth 8, which silently ALLOWED
 * anything nested deeper; the cap is deleted rather than raised.)
 */
import { readFileSync, readlinkSync, readSync, writeSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep as SEP,
} from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"stash"|"reset"|"worktreeForce"|"worktreeSymlink"|"probe"|"tmpdirCollision"} DenyRule */

/** @type {Record<DenyRule, string>} */
export const RULE_MESSAGES = {
	stash:
		"git stash is forbidden (CLAUDE.md non-negotiable) -- it is repo-global across worktrees; use `git diff > fix.patch` / `git checkout --` / `git apply` instead.",
	reset:
		"`git reset --soft origin/<branch>` / `git reset --hard` is forbidden (fixer playbook rule) -- use `git checkout HEAD -- <path>` to discard a single file instead.",
	worktreeForce:
		"a HAND-typed `git worktree remove` with two force flags is forbidden (fixer playbook rule) -- use `node scripts/prune-agent-worktrees.mjs` (liveness-checked; it applies the same double force internally once a tree is confirmed dead) for a stuck worktree, or `git worktree unlock` then a single-force remove.",
	worktreeSymlink:
		"git worktree remove on a tree whose node_modules is a symlink into another checkout is forbidden (#3173, the #2704 class -- git follows the link and empties the SHARED install, not just this worktree's copy) -- unlink it first: `rm <tree>/node_modules` (removes only the symlink, not the shared install), then retry the remove; if it is a directory, remove only that worktree copy after confirming the main checkout is intact.",
	probe:
		"an unpinned node probe that LOADS runtime code from clients/ or dist/ is forbidden (AGENTS.md Probe hygiene) -- prefix `PI_LENS_HOME=<worktree>/.probe-home`.",
	tmpdirCollision:
		"TMPDIR/TMP/TEMP must not point at the vitest harness home (AGENTS.md Probe hygiene) -- tests/support/vitest-setup.ts keeps the real TMPDIR on purpose and mkdtemps PI_LENS_HOME under os.tmpdir(), so a TMPDIR inside `.probe-home` moves the harness home into a git-ignored directory in the worktree and reds unrelated suites (#3026). Pin PI_LENS_HOME/PILENS_DATA_DIR there; give TMPDIR its own directory.",
};

/**
 * Characters after which a `#` starts a comment and a new word begins --
 * bash's own rule (a `#` in the MIDDLE of a word, `a#b`, is literal). Also
 * terminates a bare heredoc delimiter. `(`/`)` are deliberately NOT members:
 * adding them was mutation-inert (round 3's M14 stayed green), and inside a
 * `$( … )` body {@link lexRegions} already sets the word-start flag on those
 * two characters explicitly.
 */
const WORD_BREAK = /[\s;&|<>]/;

/**
 * Segment separators in the retained text. Single characters only: `&&`
 * and `||` fall out as two consecutive separators with nothing between
 * them, which {@link splitSegments} discards. `(` and `)` are here because
 * bash treats them as metacharacters that delimit commands, which is what
 * makes `(git stash)` and `( cd x && git stash )` reachable.
 */
const SEGMENT_SEPARATOR = /[;&|()\n]/;

/**
 * Characters a backslash escapes INSIDE a double-quoted span (bash: every
 * other backslash there is literal).
 */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * Parse a `<<`/`<<-` heredoc operator's delimiter, starting just after the
 * two `<` characters. A delimiter is "quoted" -- meaning bash performs NO
 * expansion in the body -- if any part of it is single-quoted,
 * double-quoted, or backslash-escaped (`<<'EOF'`, `<<"EOF"`, `<<\EOF`,
 * `<<EO'F'` all qualify). An empty delimiter (malformed `<<`) is reported
 * as `null` so the caller treats the `<<` as ordinary text instead of
 * starting a heredoc.
 *
 * @param {string} text
 * @param {number} start index just after "<<"
 * @returns {{ delimiter: string | null; stripTabs: boolean; quoted: boolean; end: number }}
 */
function parseHeredocMarker(text, start) {
	let i = start;
	let stripTabs = false;
	if (text[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (text[i] === " " || text[i] === "\t") i++;
	let delimiter = "";
	let quoted = false;
	while (i < text.length && !WORD_BREAK.test(text[i])) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			quoted = true;
			i++;
			while (i < text.length && text[i] !== ch) {
				delimiter += text[i];
				i++;
			}
			if (text[i] === ch) i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			quoted = true;
			delimiter += text[i + 1];
			i += 2;
			continue;
		}
		delimiter += ch;
		i++;
	}
	return { delimiter: delimiter || null, stripTabs, quoted, end: i };
}

/**
 * Scan an UNQUOTED-delimiter heredoc body for the only two things bash
 * still executes inside one: `$( … )` and backtick command substitution.
 * Quotes and `#` are LITERAL here (verified against real bash --
 * `cat <<EOF` / `'$(git stash)'` / `EOF` and `# $(git stash)` on a body
 * line both run), so this scan deliberately does NOT track quote or
 * comment state; a backslash still escapes the next character.
 *
 * @param {string} body
 * @param {string[]} out flat sink for every substitution body found
 */
function scanHeredocBodyForSubstitutions(body, out) {
	/** @type {string[]} */
	const found = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "\\" && i + 1 < body.length) {
			i += 2;
			continue;
		}
		if (ch === "$" && body[i + 1] === "(") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 2, ")", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		if (ch === "`") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 1, "`", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		i++;
	}
	out.push(...found);
}

/**
 * Consume one heredoc body, starting just after the newline that triggered
 * it, and DROP it: body lines are never tokenized as commands (a PR
 * description, an issue comment, a file written through `cat <<'EOF' … EOF`
 * is data, not a command line). A body whose delimiter was UNQUOTED is
 * first handed to {@link scanHeredocBodyForSubstitutions}, because bash
 * does expand `$( )`/backticks there.
 *
 * The delimiter line is matched with `<<-`'s leading tabs stripped and with
 * a trailing `\r` tolerated: a CRLF command text whose terminator never
 * matches makes the body run to end-of-text and silently swallows every
 * later command, which is a false ALLOW -- the one direction this guard
 * must never fail in.
 *
 * @param {string} text
 * @param {number} start
 * @param {{ delimiter: string; stripTabs: boolean; quoted: boolean }} heredoc
 * @param {string[]} out
 * @returns {number} index just past the delimiter line's newline (or EOF)
 */
function consumeHeredocBody(text, start, heredoc, out) {
	let i = start;
	while (i <= text.length) {
		const nl = text.indexOf("\n", i);
		const lineEnd = nl === -1 ? text.length : nl;
		let line = text.slice(i, lineEnd);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
		if (line === heredoc.delimiter) {
			if (!heredoc.quoted)
				scanHeredocBodyForSubstitutions(text.slice(start, i), out);
			return nl === -1 ? lineEnd : lineEnd + 1;
		}
		if (nl === -1) break;
		i = lineEnd + 1;
	}
	if (!heredoc.quoted) scanHeredocBodyForSubstitutions(text.slice(start), out);
	return text.length;
}

/**
 * THE region pass. Walks `text` from `start` until `closer` (`")"` for a
 * `$( … )` body, `` "`" `` for a backtick body, or `null` for end-of-text),
 * returning the text left once every inert region is subtracted, and
 * pushing every command-substitution body it finds -- at any depth, since
 * it recurses into itself to find a nested span's extent -- into `out`.
 *
 * Because the SAME pass decides span extents and consumes heredoc bodies,
 * a `)` or a backtick inside a heredoc body can never close an enclosing
 * span (#2699 review round 2's V1). That is a property of the shape, not a
 * case that was remembered.
 *
 * Subtracted: comments, heredoc bodies, and substitution bodies (the last
 * are re-scanned via `out`, not discarded). Retained: everything else,
 * including single- and double-quoted spans with their quote characters,
 * so word formation downstream is unaffected.
 *
 * @param {string} text
 * @param {number} start
 * @param {")"|"`"|null} closer
 * @param {string[]} out
 * @returns {{ end: number; retained: string; closed: boolean }}
 */
function lexRegions(text, start, closer, out) {
	let retained = "";
	let i = start;
	/** @type {"single"|"double"|null} */
	let quote = null;
	/** Nested plain `(`/`)` inside a `$( … )` body, so `$(( … ))` closes correctly. */
	let parenDepth = 0;
	let atWordStart = true;
	/** Heredoc markers seen on the current line, consumed in order at its newline. */
	/** @type {Array<{ delimiter: string; stripTabs: boolean; quoted: boolean }>} */
	let pendingHeredocs = [];
	while (i < text.length) {
		const ch = text[i];
		if (quote === "single") {
			retained += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === "double") {
			if (ch === "\\" && text[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(text[i + 1])) {
				retained += ch + text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				retained += ch;
				i++;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const span = lexRegions(text, i + 2, ")", out);
				out.push(span.retained);
				i = span.end;
				continue;
			}
			if (ch === "`") {
				i = collectBacktickSpan(text, i, out);
				continue;
			}
			retained += ch;
			i++;
			continue;
		}
		if (closer === ")" && ch === ")") {
			if (parenDepth === 0) return { end: i + 1, retained, closed: true };
			parenDepth--;
			retained += ch;
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === ")" && ch === "(") {
			parenDepth++;
			retained += ch;
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === "`" && ch === "`")
			return { end: i + 1, retained, closed: true };
		if (ch === "\\" && text[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			// An escaped character is never special -- and the backslash is
			// KEPT here so a later `\$(`/`\#` is not re-read as live syntax;
			// splitWords drops it when forming the word.
			retained += ch + text[i + 1];
			atWordStart = false;
			i += 2;
			continue;
		}
		if (ch === "#" && atWordStart) {
			const nl = text.indexOf("\n", i);
			i = nl === -1 ? text.length : nl;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
			// A here-string is a redirection with one word of input, not a
			// heredoc marker. Consume all three '<' characters so the third
			// one cannot be re-read as the start of a phantom delimiter.
			retained += "<<<";
			atWordStart = false;
			i += 3;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const marker = parseHeredocMarker(text, i + 2);
			if (marker.delimiter !== null) {
				pendingHeredocs.push({
					delimiter: marker.delimiter,
					stripTabs: marker.stripTabs,
					quoted: marker.quoted,
				});
				retained += text.slice(i, marker.end);
				atWordStart = false;
				i = marker.end;
				continue;
			}
		}
		if (ch === "\n" && pendingHeredocs.length > 0) {
			retained += "\n";
			let pos = i + 1;
			for (const heredoc of pendingHeredocs)
				pos = consumeHeredocBody(text, pos, heredoc, out);
			pendingHeredocs = [];
			atWordStart = true;
			i = pos;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const span = lexRegions(text, i + 2, ")", out);
			out.push(span.retained);
			atWordStart = false;
			i = span.end;
			continue;
		}
		if (ch === "`") {
			i = collectBacktickSpan(text, i, out);
			atWordStart = false;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		retained += ch;
		atWordStart = WORD_BREAK.test(ch);
		i++;
	}
	return { end: i, retained, closed: closer === null };
}

/**
 * Collect one backtick span that starts at `text[open]`, pushing its body
 * into `out` and returning the index just past its closing backtick.
 *
 * The extent comes from {@link lexRegions} (heredoc- and quote-aware, so a
 * heredoc body inside the span cannot close it early). The one thing a
 * backtick span needs on top: bash requires a NESTED backtick span to be
 * written `` \` ``, and it does execute it -- so when the body carries an
 * escaped backtick, the escape is undone and the body re-lexed, which
 * surfaces the inner substitution. Only `` \` `` is undone; `\$` and `\\`
 * are left alone, since undoing those would invent substitutions bash
 * treats as literal.
 *
 * @param {string} text
 * @param {number} open index of the opening backtick
 * @param {string[]} out
 * @returns {number}
 */
function collectBacktickSpan(text, open, out) {
	const span = lexRegions(text, open + 1, "`", out);
	if (span.retained.includes("\\`")) {
		const unescaped = span.retained.replace(/\\`/g, "`");
		const nested = lexRegions(unescaped, 0, null, out);
		out.push(nested.retained);
	} else {
		out.push(span.retained);
	}
	return span.end;
}

/**
 * Every region of `commandText` that bash can EXECUTE, as raw text ready
 * for {@link splitSegments}. Index 0 is the top level; the rest are
 * command-substitution bodies (from anywhere, including inside an
 * unquoted-delimiter heredoc body), already flattened, already stripped of
 * their own inert regions.
 *
 * @param {string} commandText
 * @returns {string[]}
 */
export function scannableRegions(commandText) {
	/** @type {string[]} */
	const substitutions = [];
	const { retained } = lexRegions(commandText, 0, null, substitutions);
	return [retained, ...substitutions];
}

/**
 * Split one scannable region into simple-command segments. Only quote
 * state matters here: {@link lexRegions} has already removed every
 * substitution, heredoc body and comment, so there is nothing else left
 * that could hide a separator.
 *
 * @param {string} region
 * @returns {string[]}
 */
export function splitSegments(region) {
	/** @type {string[]} */
	const segments = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let i = 0;
	const push = () => {
		if (buf.trim()) segments.push(buf);
		buf = "";
	};
	while (i < region.length) {
		const ch = region[i];
		if (quote === "single") {
			buf += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < region.length) {
			buf += ch + region[i + 1];
			i += 2;
			continue;
		}
		if (quote === "double") {
			buf += ch;
			if (ch === '"') quote = null;
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			buf += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			buf += ch;
			i++;
			continue;
		}
		if (SEGMENT_SEPARATOR.test(ch)) {
			push();
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	push();
	return segments;
}

/**
 * Split one segment into words: whitespace-separated outside quotes. A
 * quoted span fuses into the surrounding word rather than splitting on
 * internal whitespace, and its quote characters are stripped -- so
 * `echo "git stash"` yields the two words `echo` and `git stash` (one
 * opaque argument), while `git 'stash'` correctly yields `git` and
 * `stash`. Outside quotes a backslash escapes the next character and is
 * dropped, matching bash -- `\g\i\t stash` really does run `git stash`.
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function splitWords(segment) {
	/** @type {string[]} */
	const words = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let started = false;
	let i = 0;
	const flush = () => {
		if (started) words.push(buf);
		buf = "";
		started = false;
	};
	while (i < segment.length) {
		const ch = segment[i];
		if (quote === "single") {
			started = true;
			if (ch === "'") {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (quote === "double") {
			started = true;
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(segment[i + 1])) {
				buf += segment[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			started = true;
			buf += segment[i + 1];
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			started = true;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			started = true;
			i++;
			continue;
		}
		started = true;
		buf += ch;
		i++;
	}
	flush();
	return words;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Strip leading `FOO=bar` env assignments from a word list, returning the
 * assignments (for the PI_LENS_HOME probe rule) and the remaining
 * command+args words.
 *
 * @param {string[]} words
 * @returns {{ env: Record<string, string>; rest: string[] }}
 */
export function stripEnvAssignments(words) {
	/** @type {Record<string, string>} */
	const env = {};
	let i = 0;
	while (i < words.length) {
		const m = ENV_ASSIGNMENT.exec(words[i]);
		if (!m) break;
		env[m[1]] = m[2];
		i++;
	}
	return { env, rest: words.slice(i) };
}

/** Global git flags that consume a SEPARATE following token as their value. */
const GIT_TWO_TOKEN_FLAGS = new Set(["-C", "-c"]);

/**
 * Does `dir` look like a git WORKTREE checkout -- checked the same way git
 * itself tells a linked worktree apart from the main repository: only a
 * linked worktree's top-level `.git` is a FILE whose content starts with
 * `gitdir:` (the main checkout's `.git` is a directory; an ordinary
 * directory that happens to share a name has no `.git` at all). Never
 * throws: a missing `.git`, or `readFileSync` on it failing for ANY reason
 * -- ENOENT, or EISDIR (reading a directory as a file, exactly what the
 * MAIN checkout's own `.git` is) -- both land in the one catch below, so
 * it is simply "not a worktree" -- acceptance #3, a path that is not a
 * worktree is left to git, never a false deny. A separate `lstatSync`
 * "is this a file?" pre-check was tried and DELETED: `readFileSync`
 * already throws EISDIR for exactly the directory case that pre-check
 * existed to catch (measured directly: `fs.readFileSync` on a real
 * directory throws `EISDIR`), so the pre-check never changed the verdict
 * and mutating it out left every test in this file green.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeGitWorktree(dir) {
	try {
		return readFileSync(join(dir, ".git"), "utf8")
			.trimStart()
			.startsWith("gitdir:");
	} catch {
		return false;
	}
}

/**
 * Does `worktreeDir` contain a `node_modules` entry that is a SYMLINK whose
 * target resolves OUTSIDE `worktreeDir` -- the #3173 hazard (twice on
 * 2026-09-16, the #2704 class): the fixer playbook's own speed convention
 * (`ln -s <main checkout>/node_modules node_modules`) means a plain
 * `git worktree remove` on that tree makes git follow the link and empty
 * the SHARED install it points at, not just this worktree's own copy. A
 * real `node_modules` DIRECTORY, a missing entry, and a symlink that stays
 * INSIDE the worktree are all fine and return false -- deliberately
 * narrower than "any symlink", since only an OUTSIDE target can empty
 * something other than this worktree.
 *
 * `readlinkSync` alone decides "is this even a symlink" -- no separate
 * `lstatSync` type check, the same deletion as {@link looksLikeGitWorktree}'s:
 * measured directly, `readlinkSync` throws ENOENT for a missing entry and
 * EINVAL for a REAL directory or file, both caught below, so a pre-check
 * never changed the verdict and mutating it out left every test green. Its
 * raw link text (not `realpathSync`'s resolved target), so a dangling
 * symlink (target does not exist) is still classified correctly instead of
 * throwing ENOENT on the target.
 *
 * @param {string} worktreeDir
 * @returns {boolean}
 */
function hasNodeModulesSymlinkOutside(worktreeDir) {
	const nodeModulesPath = join(worktreeDir, "node_modules");
	let target;
	try {
		target = readlinkSync(nodeModulesPath);
	} catch {
		return false;
	}
	const resolvedTarget = resolve(dirname(nodeModulesPath), target);
	const rel = relative(worktreeDir, resolvedTarget);
	return rel === ".." || rel.startsWith(`..${SEP}`) || isAbsolute(rel);
}

/**
 * Classify a `git` invocation's args (after the leading "git" word).
 * Walks past global options (`-C <dir>` and `-c <key>=<value>` are treated
 * as taking a separate value; every other `-x`/`--x` global option is
 * assumed to take none, which is all #2699's deny/allow strings need) to
 * find the subcommand.
 *
 * `cwd` (the PreToolUse payload's own `cwd`, threaded down from
 * {@link classifyPayload}) resolves a RELATIVE `git worktree remove <path>`
 * argument the same way git itself would, for the {@link
 * hasNodeModulesSymlinkOutside} check -- an absolute argument is used as
 * given. NOT handled (documented, not fixed, matching this file's other
 * blind spots): a leading `-C <dir>` global option changes git's own
 * working directory, which would change what a relative worktree argument
 * resolves against; this scan does not track it, so a `-C`-relative
 * worktree path resolves against the PAYLOAD cwd instead -- proportionate,
 * since every fixer/orchestrator convention in this repo names the
 * worktree by its absolute path.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {DenyRule | null}
 */
function classifyGit(args, cwd) {
	let i = 0;
	while (i < args.length) {
		if (GIT_TWO_TOKEN_FLAGS.has(args[i])) {
			i += 2;
			continue;
		}
		if (args[i].startsWith("-")) {
			i += 1;
			continue;
		}
		break;
	}
	const subcommand = args[i];
	if (subcommand === "stash") return "stash";
	if (subcommand === "reset") {
		const rest = args.slice(i + 1);
		if (rest.includes("--hard")) return "reset";
		if (rest.includes("--soft") && rest.some((a) => a.startsWith("origin/")))
			return "reset";
		return null;
	}
	if (subcommand === "worktree" && args[i + 1] === "remove") {
		const rest = args.slice(i + 2);
		let forceCount = 0;
		const positionals = [];
		for (const a of rest) {
			if (a === "-f" || a === "--force") forceCount++;
			else if (/^-f{2,}$/.test(a)) forceCount += a.length - 1;
			else if (!a.startsWith("-")) positionals.push(a);
		}
		if (forceCount >= 2) return "worktreeForce";
		const worktreeArg = positionals[0];
		if (worktreeArg) {
			const worktreeDir = isAbsolute(worktreeArg)
				? worktreeArg
				: resolve(cwd ?? process.cwd(), worktreeArg);
			if (
				looksLikeGitWorktree(worktreeDir) &&
				hasNodeModulesSymlinkOutside(worktreeDir)
			)
				return "worktreeSymlink";
		}
		return null;
	}
	return null;
}

/**
 * Does `fileArg` name a file under a top-level `dirName` directory --
 * checked by exact PATH-SEGMENT membership, never a substring test (a
 * substring test on the whole command TEXT is exactly the #2699 review
 * round 2 F5 false-positive: a `node -e` payload that merely MENTIONS
 * "clients/" in an unrelated string still substring-matched). Segment
 * membership is naturally robust to a leading `./`, a `.\`-style Windows
 * separator, and an absolute path -- `"./clients/x.mjs"`,
 * `"/abs/worktree/clients/x.mjs"`, and `"clients/x.mjs"` all split into a
 * `"clients"` segment, so no separate normalization step (strip `./`,
 * resolve against `cwd`) is needed the way a `startsWith("clients/")`
 * prefix check would have required. Accepted imprecision: a file legitimately
 * under some OTHER project's `clients/`/`dist/` directory (e.g.
 * `vendor/other-repo/dist/x.mjs`) also matches -- proportionate to a
 * heuristic guard, and no narrower check can tell the two apart from argv
 * text alone.
 *
 * @param {string} fileArg
 * @param {string} dirName
 * @returns {boolean}
 */
function fileArgUnderDir(fileArg, dirName) {
	return fileArg.split(/[\\/]+/).includes(dirName);
}

/**
 * A `require(`/`import(` call, or a bare `from`, whose string-literal
 * specifier mentions a `clients/` or `dist/` path segment -- the shape of
 * an `-e`/`-p` payload that actually LOADS runtime code, as opposed to one
 * that merely mentions "clients/" in an unrelated string (#2699 review
 * round 2 F5: the orchestrator's `node -e` doc-patching idiom prints or
 * greps text that can incidentally contain "clients/" without ever loading
 * it). Accepted blind spot: a specifier built from a variable
 * (`require(mod)`) is invisible to a text pattern -- documented, not fixed,
 * since no static text scan can resolve a runtime-computed specifier.
 */
const RUNTIME_LOAD_PATTERN =
	/\b(?:require|import)\s*\(\s*["'`][^"'`]*(?:clients|dist)\/[^"'`]*["'`]|\bfrom\s+["'`][^"'`]*(?:clients|dist)\/[^"'`]*["'`]/;

/**
 * Classify a `node`/`nodejs` invocation's args. Denies only when ALL hold
 * (the #2699 probe rule, narrowed in review round 2 F5): the command runs a
 * `.mjs`/`.js` file argument that is ITSELF under `clients/`/`dist/`, or an
 * `-e`/`--eval`/`--input-type`/`-p` payload whose text actually LOADS
 * runtime code from `clients/`/`dist/` (a `require(`/`import(`/`from`
 * specifier naming it, per {@link RUNTIME_LOAD_PATTERN}) -- not merely a
 * payload that mentions "clients/" in passing; and neither this command's
 * own env assignments nor `process.env` carries `PI_LENS_HOME`.
 *
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} rawSegment
 * @returns {DenyRule | null}
 */
function classifyNode(args, env, rawSegment) {
	const hasFlag = args.some(
		(a) =>
			a === "-e" ||
			a === "--eval" ||
			a === "-p" ||
			a === "--input-type" ||
			a.startsWith("--input-type="),
	);
	const fileArg = args.find(
		(a) => !a.startsWith("-") && /\.(?:mjs|js)$/.test(a),
	);
	const fileArgLoadsRuntimeCode =
		fileArg !== undefined &&
		(fileArgUnderDir(fileArg, "clients") || fileArgUnderDir(fileArg, "dist"));
	const evalPayloadLoadsRuntimeCode =
		hasFlag && RUNTIME_LOAD_PATTERN.test(rawSegment);
	if (!fileArgLoadsRuntimeCode && !evalPayloadLoadsRuntimeCode) return null;
	if ("PI_LENS_HOME" in env) return null;
	if ("PI_LENS_HOME" in process.env) return null;
	return "probe";
}

/**
 * The environment variables Node's `os.tmpdir()` consults. MEASURED, not
 * assumed -- one child process per variable on node v22.22.1 (this repo's
 * runtime), Linux: `TMPDIR=/a` -> `/a`, `TMP=/b` -> `/b`, `TEMP=/c` ->
 * `/c`, all three set -> `/a`, none -> `/tmp`. All three reach the harness,
 * so the guard covers all three rather than only the one the incident used.
 */
const TEMP_DIR_VARS = ["TMPDIR", "TMP", "TEMP"];

/**
 * The directory name AGENTS.md "Probe hygiene" prescribes for a pinned
 * `PI_LENS_HOME` (and the {@link RULE_MESSAGES}.probe message hands out).
 */
const HARNESS_HOME_SEGMENT = ".probe-home";

/** `$PI_LENS_HOME` / `${PI_LENS_HOME}` -- the same directory under its
 *  variable spelling, which is what an agent reaches for right after
 *  reading the `probe` rule's message. The name boundary matters: without
 *  it `$PI_LENS_HOME_TMP` and `$PI_LENS_HOMEDIR/x` -- different variables,
 *  naming different directories -- were both denied (review round 2 T3). */
const HARNESS_HOME_VARIABLE =
	/\$\{PI_LENS_HOME\}|\$PI_LENS_HOME(?![A-Za-z0-9_])/;

/**
 * Deny a `TMPDIR`/`TMP`/`TEMP` assignment that aims Node's temp directory
 * at the vitest harness's own `PI_LENS_HOME` (#3026, 2026-09-15).
 *
 * `tests/support/vitest-setup.ts` deliberately keeps the REAL `TMPDIR` and
 * mkdtemps the per-worker `PI_LENS_HOME` under `os.tmpdir()`. Point
 * `TMPDIR` at `<worktree>/.probe-home` and that home lands inside the
 * checkout, in a directory `.gitignore` ignores -- so every suite whose
 * fixtures live under `os.tmpdir()` is suddenly reading ignored paths. The
 * #3026 fixer did exactly that and reported "16 suites red on
 * origin/master"; the tree was green. Measured again on this branch:
 * `tests/clients/ext-gate-before-ignore.test.ts` is 8/8 green with TMPDIR
 * elsewhere and 7 failed / 1 passed with `TMPDIR=$PWD/.probe-home`, same
 * build, same tree.
 *
 * Matching is by path SEGMENT ({@link fileArgUnderDir}), never substring,
 * so `$PWD/.probe-home`, `/abs/.probe-home` and `.probe-home/sub` all
 * match while `.probe-home-2` does not.
 *
 * Known limit (review round 2): the offending path has to appear in the
 * assignment's own text. A third variable hides it --
 * `export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME` allows,
 * because resolving it would mean evaluating the shell's variable
 * environment, which this static scan does not do (the same class as the
 * header's "command word assembled by expansion" blind spot).
 *
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
function classifyTempDirVars(env) {
	for (const name of TEMP_DIR_VARS) {
		const value = env[name];
		if (value === undefined) continue;
		if (fileArgUnderDir(value, HARNESS_HOME_SEGMENT)) return "tmpdirCollision";
		if (HARNESS_HOME_VARIABLE.test(value)) return "tmpdirCollision";
	}
	return null;
}

/**
 * Words that just mean "run the following command", stripped before the
 * command word is identified. `command`/`exec`/`env` came from review
 * round 2 F7; `sudo`/`time` from round 3's V5 (both confirmed against real
 * bash to run their argument). Only the BARE forms are handled -- a prefix
 * carrying its own options (`sudo -u root`, `nice -n 10`, `timeout 30`) is
 * in the header's NOT-handled list.
 */
const RUNNER_PREFIX_WORDS = new Set(["command", "exec", "env", "sudo", "time"]);

/**
 * Strip a leading `{` command-group brace and any leading runner-prefix
 * words (repeated, so `command env git stash` and `{ sudo git stash` both
 * resolve to `git stash`). `env`'s own `FOO=bar` assignments (if any) still
 * parse correctly afterward via {@link stripEnvAssignments} once `env`
 * itself is dropped.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function stripCommandGroupAndRunnerPrefixes(words) {
	let i = 0;
	if (words[i] === "{") i++;
	while (i < words.length && RUNNER_PREFIX_WORDS.has(words[i])) i++;
	return words.slice(i);
}

/**
 * The final path segment of a command word -- so `/usr/bin/git`, `./git`,
 * and `git` all resolve to the same command name (#2699 review round 2 F7).
 *
 * @param {string} cmd
 * @returns {string}
 */
function commandBasename(cmd) {
	const idx = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
	return idx === -1 ? cmd : cmd.slice(idx + 1);
}

/**
 * Classify one segment. `sharedEnv` carries `export VAR=val` (or a
 * standalone `VAR=val` with no command on the same segment) assignments
 * forward to LATER segments in the same {@link findDeny} scan (#2699 review
 * round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<worktree>/.probe-home`
 * as an earlier `;`/newline-separated segment, not only as this segment's
 * own prefix or `process.env`). The `export` builtin NEVER runs a trailing
 * command in real bash -- any word after its assignments is another (bare)
 * name marked for export, not a command -- so a segment starting with
 * `export` always terminates here, persisting into `sharedEnv` (mutated in
 * place) and returning `null`. A NON-exported `FOO=bar cmd` prefix, by
 * contrast, applies only to THIS segment's own command (matching real
 * bash), merged into the `effectiveEnv` passed to {@link classifyNode}.
 *
 * @param {string} rawSegment
 * @param {Record<string, string>} sharedEnv
 * @param {string} [cwd] the PreToolUse payload's own cwd, for {@link classifyGit}'s worktree-path resolution
 * @returns {DenyRule | null}
 */
export function classifySegment(rawSegment, sharedEnv = {}, cwd) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	if (words[0] === "export") {
		const { env: exported } = stripEnvAssignments(words.slice(1));
		Object.assign(sharedEnv, exported);
		return classifyTempDirVars(exported);
	}
	const { env: segmentEnv, rest } = stripEnvAssignments(words);
	// Before the command dispatch: the #3026 incident's own command was
	// `TMPDIR=$PWD/.probe-home npx vitest run …`, and `npx` is a command this
	// guard classifies as nothing at all. The assignment is the offence, so
	// it is judged where it is written, whatever follows it.
	const tempDirCollision = classifyTempDirVars(segmentEnv);
	if (tempDirCollision) return tempDirCollision;
	if (rest.length === 0) {
		// A standalone (non-exported) `VAR=val` with no command -- lenient:
		// persist it too (real bash would keep it a local shell variable, not
		// exported, but there is no command in this segment for the
		// distinction to matter either way).
		Object.assign(sharedEnv, segmentEnv);
		return null;
	}
	const effectiveEnv = { ...sharedEnv, ...segmentEnv };
	const cmd = commandBasename(rest[0]);
	const args = rest.slice(1);
	if (cmd === "git") return classifyGit(args, cwd);
	if (cmd === "node" || cmd === "nodejs")
		return classifyNode(args, effectiveEnv, rawSegment);
	return null;
}

/**
 * Scan a full Bash command for the first denied rule: every executable
 * region {@link scannableRegions} found, split into segments and
 * classified. The top-level region runs first and accumulates `export`ed
 * assignments; each substitution region then starts from a COPY of that
 * state -- an approximation of bash's left-to-right export visibility, not
 * a fully-ordered interleaving with what appears textually inside a
 * `$( )`/backtick span (#2699 review round 2 F2).
 *
 * @param {string} commandText
 * @param {string} [cwd] the PreToolUse payload's own cwd, threaded to every segment
 * @returns {DenyRule | null}
 */
export function findDeny(commandText, cwd) {
	const regions = scannableRegions(commandText);
	/** @type {Record<string, string>} */
	const sharedEnv = {};
	for (let index = 0; index < regions.length; index++) {
		const env = index === 0 ? sharedEnv : { ...sharedEnv };
		for (const segment of splitSegments(regions[index])) {
			const rule = classifySegment(segment, env, cwd);
			if (rule) return rule;
		}
	}
	return null;
}

/**
 * Run the guard over the PreToolUse payload. Pure (besides the
 * `PI_LENS_HOME` env read already folded into {@link classifyNode}) --
 * takes the parsed payload, returns the rule to deny for (or null to
 * allow). Exported so tests can drive it without spawning a child process
 * when they only care about classification, not the stdin/exit-code
 * plumbing.
 *
 * @param {unknown} payload
 * @returns {DenyRule | null}
 */
export function classifyPayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const p =
		/** @type {{ tool_name?: unknown; tool_input?: unknown; cwd?: unknown }} */ (
			payload
		);
	if (p.tool_name !== "Bash") return null;
	const toolInput = p.tool_input;
	if (!toolInput || typeof toolInput !== "object") return null;
	const command = /** @type {{ command?: unknown }} */ (toolInput).command;
	if (typeof command !== "string" || !command.trim()) return null;
	const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
	return findDeny(command, cwd);
}

// #3089: nothing in the stdlib waits for fd 0 to become readable
// synchronously, and a bare retry loop would spin a core while the payload
// is still arriving. `Atomics.wait` is the one sleep that yields the CPU --
// same mechanism scripts/with-memory-watch.mjs uses for its own EAGAIN
// retry on the write side.
const READ_RETRY_SLEEP_MS = 5;
const readRetryPark = new Int32Array(new SharedArrayBuffer(4));

// #3089 review round 2 F3: the three ALLOW-BY-FAILURE paths in run() below
// (empty-or-unparseable raw text, a JSON.parse failure, and this function's
// own crash guard) used to exit 0 with empty stderr -- indistinguishable
// from a genuine "nothing to check" allow, which is exactly why the
// original readFileSync(0) short read was invisible for a release cycle.
// This note fires on the two paths that saw SOME input and failed to make
// sense of it; a genuinely empty stream (nothing ever arrived, no error) is
// still silent -- that is the ordinary "hook invoked with no payload" case,
// not a failure. Used ONLY on the JSON.parse failure path -- the payload
// genuinely could not be parsed there. The crash guard (any other throw,
// including a classifier crash on a payload that WAS read and parsed fine)
// gets its own cause-bearing message instead (#3089 review round 3 N1):
// labeling a classifier crash "unreadable or unparseable" is a wrong label
// on the most important fail-open this hook has -- worse than the silence
// it replaced, because it actively misdescribes what happened.
const UNREADABLE_PAYLOAD_NOTE =
	"guard-bash: payload unreadable or unparseable; allowing\n";

// #3089 review round 3 N2: a closed or read-only stderr fd (EBADF, EPIPE,
// ...) must never turn an intended exit-0 allow into an uncaught-exception
// exit 1. `process.stderr.write` is the wrong primitive to guard here --
// verified directly: it goes through Node's Writable stream machinery,
// which never throws synchronously for an I/O failure (it reports one via
// an async `'error'` event instead), so `try { process.stderr.write(text)
// } catch {}` alone still crashed with exit 1 in the read-only-fd
// reproduction below. `fs.writeSync(2, text)` bypasses that machinery and
// writes the fd directly -- confirmed to throw EBADF SYNCHRONOUSLY for the
// same read-only fd, which a try/catch can actually catch. Every stderr
// write in this file's hook path goes through this helper so a broken
// stderr can never be the thing that blocks (or crashes) the tool -- the
// same "must never throw" promise the file's header already makes for a
// classification crash.
function note(text) {
	try {
		writeSync(2, text);
	} catch {
		// The record is lost, but losing a record must never cost the exit
		// code that record was trying to explain.
	}
}

/**
 * Read stdin synchronously, draining fd 0 to EOF. Never blocks on an
 * interactive terminal. Returns "" for a genuine empty stream (a read that
 * cleanly hits EOF on the first call, no bytes ever seen); THROWS a
 * genuine, non-retryable read error (EBADF, a closed fd, ...) instead of
 * swallowing it, so {@link run}'s own crash guard can tell "nothing to
 * read" apart from "reading failed" and note the latter (review round 2
 * F3) while keeping the never-throws contract at the run() boundary.
 *
 * #3089: `readFileSync(0, "utf8")` fails open on a payload larger than a
 * pipe buffer. Node's spawnSync sets the child's stdin pipe to
 * non-blocking once the parent starts pumping its own synchronous event
 * loop to feed `input`; a `read(2)` issued before the next chunk has
 * landed then returns EAGAIN, `readFileSync` does not retry, and the
 * thrown error was swallowed by this function's own catch-all, returning
 * "" for a payload that was still arriving. Measured on this host,
 * reproducible from ~500 KB: `spawnSync(HOOK, { input })` for a
 * >=1 MB PreToolUse JSON payload throws
 * `EAGAIN: resource temporarily unavailable, read` out of
 * `readFileSync(0, "utf8")`, and the hook exits 0 instead of denying. A
 * `read(2)` loop that retries EAGAIN (this function) and keeps
 * accumulating chunks until a read returns 0 -- true EOF, not "nothing
 * available yet" -- closes that gap regardless of how many chunks the
 * payload arrives in or how far apart in time they land.
 *
 * @returns {string}
 */
function readStdin() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	const chunk = Buffer.alloc(65536);
	for (;;) {
		let bytesRead;
		try {
			bytesRead = readSync(0, chunk, 0, chunk.length, null);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				Atomics.wait(readRetryPark, 0, 0, READ_RETRY_SLEEP_MS);
				continue;
			}
			// A read error that is not "try again" (EBADF, a closed fd, ...)
			// propagates to run()'s crash guard, which notes it and still
			// exits 0 -- never throws past that boundary.
			throw error;
		}
		if (bytesRead === 0) break; // true EOF: the writer closed its end.
		chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * @returns {number} process exit code -- 0 to allow, 2 to deny.
 */
export function run() {
	try {
		const raw = readStdin();
		if (!raw.trim()) return 0;
		/** @type {unknown} */
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			note(UNREADABLE_PAYLOAD_NOTE);
			return 0;
		}
		const rule = classifyPayload(payload);
		if (!rule) return 0;
		note(`${RULE_MESSAGES[rule]}\n`);
		return 2;
	} catch (error) {
		// A crash in this hook -- a genuine readStdin() read error (EBADF, a
		// closed fd, ...) OR a classifier crash on a payload that WAS read
		// and parsed fine (the #2699 r3 depth-5000 nesting case throws
		// RangeError here, not in readStdin or JSON.parse) -- must never be
		// the thing that blocks the tool, but it also must not be silently
		// indistinguishable from an ordinary allow (#3089 review round 2
		// F3), and it must not claim the payload was "unreadable or
		// unparseable" when it demonstrably was read and parsed (#3089
		// review round 3 N1) -- error.code (a read error) or error.name (a
		// RangeError, or anything else classification can throw) names the
		// actual cause instead.
		note(
			`guard-bash: ${error?.code ?? error?.name ?? "error"} while checking payload; allowing\n`,
		);
		return 0;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = run();
}
