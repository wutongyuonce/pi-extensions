import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_DIAGNOSTIC_MARKER_PATTERN,
	isConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import {
	normalizeParseErrorReason,
	resetIgnoredConfigWarnCache,
	warnIgnoredConfigOnce,
} from "../../clients/config-warn.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";

// #2431: `logExtension` is a no-op under `isTestMode()` (and, live, its NDJSON
// writer already redacts the serialized line — see ndjson-logger.ts). Neither
// of those defends the SOURCE this PR fixes: what `warnIgnoredConfigOnce`
// hands `logExtension` before either layer runs. Mocked here (same pattern as
// tests/clients/lsp/config.test.ts) to inspect exactly that.
const loggedExtension: Array<{
	message: string;
	metadata?: Record<string, unknown>;
}> = [];
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: {
			message: string;
			metadata?: Record<string, unknown>;
		}) => {
			loggedExtension.push({
				message: entry.message,
				metadata: entry.metadata,
			});
		},
	};
});

/**
 * The shared ignored-config seam (#2418 review, S1 + F6).
 *
 * S1 collapsed three near-identical warn bodies into one helper, so this file
 * pins the two things that collapse could have silently changed: the rendered
 * prose (byte-identical per subsystem, because two shipped test files assert on
 * it and users grep it today) and the warn-once latch.
 *
 * F6 is the other half. Before it, `DegradationRecord.code` and the whole
 * `PILENS_CFG_*` namespace had no emitter at all — the plumbing was dead code
 * dressed as a policy. A config the user wrote could be ignored for a whole
 * session with nothing counted anywhere; the notification was one-shot and the
 * ledger, the repo's own durable answer to "what degraded this session", knew
 * nothing about it. These tests are the proof the path is live.
 */

/**
 * The subject separator, built rather than spelled: a literal NUL in a source
 * file makes the file binary to grep and to half the repo's own scanners.
 */
const NUL = String.fromCharCode(0);

const notified: Array<{ message: string; level: string | undefined }> = [];

beforeEach(() => {
	notified.length = 0;
	loggedExtension.length = 0;
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	resetUserNotifier();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
});

function configIgnoredGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "config-ignored",
	);
}

describe("warnIgnoredConfigOnce prose (#2418)", () => {
	it.each([
		["lsp-config", "ignoring invalid LSP config"],
		["lens-config", "ignoring invalid global config"],
		["project-lens-config", "ignoring invalid project config"],
	] as const)("renders %s prose byte-identically", (subsystem, prefix) => {
		warnIgnoredConfigOnce({
			subsystem,
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toBe(
			`pi-lens: ${prefix} /tmp/a.json: Unexpected token } [PILENS_CFG_0001]`,
		);
		expect(notified[0].level).toBe("warning");
	});

	it("ends in a marker a user can match on, not in prose", () => {
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		const matched = CONFIG_DIAGNOSTIC_MARKER_PATTERN.exec(notified[0].message);
		expect(matched?.[1]).toBe("PILENS_CFG_0001");
		expect(isConfigDiagnosticCode(matched?.[1])).toBe(true);
		expect(notified[0].message.endsWith("[PILENS_CFG_0001]")).toBe(true);
	});

	it("honors an explicit code override", () => {
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "legacy key",
			code: "PILENS_CFG_0002",
		});
		expect(notified[0].message.endsWith("[PILENS_CFG_0002]")).toBe(true);
	});
});

describe("warnIgnoredConfigOnce latch (#2418)", () => {
	it("warns once per (subsystem, file, key, reason)", () => {
		const warn = () =>
			warnIgnoredConfigOnce({
				subsystem: "lens-config",
				file: "/tmp/a.json",
				reason: "bad",
			});
		warn();
		warn();
		warn();
		expect(notified).toHaveLength(1);
	});

	it("warns again for a different reason on the same file", () => {
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "worse",
		});
		expect(notified).toHaveLength(2);
	});

	it("does not let one subsystem's reset un-latch another's", () => {
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		expect(notified).toHaveLength(2);

		resetIgnoredConfigWarnCache("lens-config");
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		// The lens-config one warns again; the project one is still latched.
		expect(notified).toHaveLength(3);
	});
});

describe("warnIgnoredConfigOnce ledger record (#2418 F6)", () => {
	it("records a config-ignored degradation", () => {
		expect(configIgnoredGroup()).toBeUndefined();
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});
		const group = configIgnoredGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]).toEqual({
			// No key, no separator: a whole-file rejection is subject `<file>`,
			// not `<file>` plus a bare NUL separator (#2418 review R3, S1).
			subject: "/tmp/a.json",
			reason: "Unexpected token }",
		});
	});

	it("keys the subject on file AND key, so a per-key rejection is its own row", () => {
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "not an array",
			key: "rules.disable",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "unreadable",
		});
		const group = configIgnoredGroup();
		expect(group?.count).toBe(2);
		expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
			`/tmp/a.json${NUL}rules.disable`,
			"/tmp/a.json",
		]);
	});

	it("counts one row per subject even when the prose warns twice", () => {
		// The latch is per (file, key, reason); the ledger is per (kind, subject).
		// Coarser on purpose: two parse errors in one file are one ignored config.
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "worse",
		});
		expect(notified).toHaveLength(2);
		expect(configIgnoredGroup()?.count).toBe(1);
	});
});

/**
 * The session-boundary half (#2418 review round 3, F1).
 *
 * The warn-once latch is a PROCESS-lifetime Set and it sat in front of the
 * ledger record, so from session 2 onward a config that was still being
 * ignored produced no `config-ignored` row at all: `handleSessionStart` calls
 * `resetDegradationLedger()`, nothing re-armed the latch, and the early return
 * swallowed the record the new session was supposed to carry. Catalog shape 17
 * — a gate that outlives the ledger it guards silently eats the record it was
 * only ever meant to de-duplicate — the same defect `refreshGrammarSessionLatches`
 * exists to prevent in `clients/tree-sitter-client.ts`.
 */
describe("warnIgnoredConfigOnce across a session boundary (#2418 review R3 F1)", () => {
	const warn = () =>
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});

	it("records the ledger row again in the next session", () => {
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);

		// Exactly what handleSessionStart does first thing. The config on disk
		// is still broken; session 2 must still be able to answer "did this
		// session ignore a config the user wrote".
		resetDegradationLedger();
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);
		expect(configIgnoredGroup()?.latestReasons[0]).toEqual({
			subject: "/tmp/a.json",
			reason: "Unexpected token }",
		});
	});

	it("still does not re-nag the user across that boundary", () => {
		warn();
		expect(notified).toHaveLength(1);
		resetDegradationLedger();
		warn();
		// The ledger re-arms per session; the human-facing warning stays
		// once-per-process, which is what the latch is for.
		expect(notified).toHaveLength(1);
	});

	it("still records only one row per subject inside one session", () => {
		warn();
		warn();
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);
	});
});

/**
 * #2431: Node's `JSON.parse` embeds a slice of the source text in its own
 * `SyntaxError#message` — `Unexpected token 'g', ..."piToken": ghp_SECRET"...
 * is not valid JSON` is the LITERAL shape from this issue's evidence. Every
 * loader used to pass `error.message` straight through as `reason`, so a
 * malformed config that happened to carry a credential leaked it into all
 * three sinks this seam owns. This section pins the fix AT the seam: a real
 * `JSON.parse` failure on content containing a `ghp_`-shaped token never
 * reaches the notification, `logExtension`'s metadata, or the ledger row.
 */
describe("warnIgnoredConfigOnce parse-error reason redaction (#2431)", () => {
	// GitHub PAT shape: `ghp_` + 36 alphanumerics. Real enough for
	// `redact/secrets.ts`'s own scanner to recognize, exactly like a config
	// author's real token would be.
	const TOKEN = `ghp_${"A".repeat(36)}`;

	function realJsonParseError(content: string): SyntaxError {
		try {
			JSON.parse(content);
		} catch (error) {
			if (error instanceof SyntaxError) return error;
			throw error;
		}
		throw new Error("expected JSON.parse to throw for this fixture");
	}

	it("normalizeParseErrorReason never keeps a JSON.parse SyntaxError's message", () => {
		// The exact evidence shape (#2431): an unquoted value next to a secret
		// token, which V8 reports with NO derivable position at all — only a
		// snippet. Node 24: `Unexpected token 'g', ..."piToken": ghp_AAAA..."...
		// is not valid JSON`.
		const error = realJsonParseError(`{"piToken": ${TOKEN}}`);
		// V8 truncates its snippet, so the raw message carries a PREFIX of the
		// token rather than all 40 chars — still a real leak (a prefix narrows a
		// brute-force search enormously), and still what this fix must strip.
		expect(error.message).toContain("ghp_");

		const reason = normalizeParseErrorReason(error);
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("ghp_");
		expect(reason).toBe("SyntaxError");
	});

	it("normalizeParseErrorReason keeps line/col when V8 states one, never the message", () => {
		// `{` alone: V8 states `Expected property name or '}' in JSON at
		// position 1 (line 1 column 2)` — no snippet, but a real position.
		const error = realJsonParseError("{");
		const reason = normalizeParseErrorReason(error);
		expect(reason).toBe("SyntaxError at line 1 col 2");
	});

	// Review round 2, F2: `error instanceof SyntaxError` is realm-bound. A
	// `JSON.parse` failure thrown inside a `vm` context (a different realm's
	// `SyntaxError` constructor) fails that check and falls into the generic
	// `error instanceof Error` branch, which only gets `redactSecrets` as a
	// backstop — and V8's truncated parse-error snippet is far shorter than
	// every scanner's `minSuffixLength` (16-40 chars), so it is NOT caught
	// there either. The discriminator must duck-type on `error.name`.
	it("normalizes a cross-realm SyntaxError (vm) the same as an in-realm one, no snippet", () => {
		const TOKEN = `ghp_${"C".repeat(36)}`;
		const context = vm.createContext({});
		let error: unknown;
		try {
			// The same evidence shape as #2431's own fixture, but thrown inside a
			// DIFFERENT V8 context so its `SyntaxError` is not this realm's.
			vm.runInContext(`JSON.parse('{"piToken": ${TOKEN}}')`, context);
		} catch (caught) {
			error = caught;
		}
		expect(typeof error).toBe("object");
		expect(error).not.toBeNull();
		// Proof this is genuinely cross-realm: the in-process SyntaxError
		// constructor does NOT recognize it (nor does the in-process Object —
		// its prototype chain resolves through the vm context's own realm).
		expect(error instanceof SyntaxError).toBe(false);
		expect(error instanceof Object).toBe(false);
		expect(String(error)).toContain("ghp_");

		const reason = normalizeParseErrorReason(error);
		// `redactSecrets` alone cannot be trusted here: V8's truncated snippet
		// is shorter than every scanner `minSuffixLength` (16-40 chars), so a
		// caller that fell through to the generic `redactSecrets(String(error))`
		// backstop would still leak a usable token prefix. The discriminator
		// must recognize this as a SyntaxError and strip the message entirely.
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("ghp_");
		expect(reason).toBe("SyntaxError");
	});

	it("routes a non-SyntaxError caught error (a fs error, a hand-thrown validation error) through redact/secrets.ts", () => {
		// Not `JSON.parse`'s own SyntaxError, so the message is not DOCUMENTED
		// to embed file content — but still defense-in-depth redacted (#2431
		// AC3), never trusted verbatim on the strength of "it isn't SyntaxError".
		const error = new TypeError(`expected an object, found token ${TOKEN}`);
		const reason = normalizeParseErrorReason(error);
		expect(reason).not.toContain(TOKEN);
		expect(reason).toContain("[REDACTED:github-token]");
		// Everything else about the message survives — this is defense in
		// depth, not the same total strip as the SyntaxError branch.
		expect(reason).toContain("expected an object, found token");
	});

	it("does not leak the token into the notification, logExtension metadata, or the ledger row", () => {
		const content = `{"piToken": ${TOKEN}, "other": "value"}`;
		const error = realJsonParseError(content);

		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/.pi-lens.json",
			reason: { parseError: error },
		});

		// Sink 1: the human-facing notification.
		expect(notified).toHaveLength(1);
		expect(notified[0].message).not.toContain(TOKEN);
		expect(notified[0].message).not.toContain("ghp_");

		// Sink 2: the extension.log line `warnIgnoredConfigOnce` hands
		// `logExtension` — message AND metadata.
		expect(loggedExtension).toHaveLength(1);
		expect(loggedExtension[0].message).not.toContain(TOKEN);
		expect(loggedExtension[0].message).not.toContain("ghp_");
		expect(JSON.stringify(loggedExtension[0].metadata)).not.toContain(TOKEN);
		expect(JSON.stringify(loggedExtension[0].metadata)).not.toContain("ghp_");

		// Sink 3: the durable degradation-ledger row (subject + reason;
		// `metadata` for this kind is always just `{subsystem, configPath}` —
		// the file's PATH, never its content, so it carries no token by
		// construction — verified anyway).
		const group = configIgnoredGroup();
		expect(group?.count).toBe(1);
		const entry = group?.latestReasons[0];
		expect(entry?.subject).not.toContain(TOKEN);
		expect(entry?.reason).not.toContain(TOKEN);
		expect(entry?.reason).not.toContain("ghp_");
		expect(entry?.reason).toBe("SyntaxError");
	});

	it("a hand-authored reason (not a parse error) still passes through verbatim", () => {
		// Regression guard on the OTHER half of the union: normalization must
		// never touch a caller's own validated-value message.
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "widget.visible must be a boolean",
		});
		expect(notified[0].message).toContain("widget.visible must be a boolean");
	});

	// Review round 2, F1: `normalizeParseErrorReason` was never the only path
	// into the three sinks. `project-lens-config.ts` and `lens-config.ts` both
	// interpolate a user-authored KEY (or rule id) straight from the parsed
	// JSON into a HAND-AUTHORED `reason` string (`unknown key "${key}" is not
	// a recognized pi-lens setting`), which takes the plain-string branch at
	// the top of `warnIgnoredConfigOnce` untouched by any redaction. A key or
	// rule id named after a live credential (a `.pi-lens.json` a user pasted a
	// token into as an object KEY, not just a value) reached the notification,
	// the log, and the ledger reason verbatim.
	it("redacts a secret-shaped KEY interpolated into a hand-authored reason string", () => {
		const TOKEN = `ghp_${"B".repeat(36)}`;
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: `unknown key "${TOKEN}" is not a recognized pi-lens setting (check for a typo); ignored`,
		});
		expect(notified).toHaveLength(1);
		expect(notified[0].message).not.toContain(TOKEN);
		expect(notified[0].message).not.toContain("ghp_");

		expect(loggedExtension).toHaveLength(1);
		expect(loggedExtension[0].message).not.toContain(TOKEN);
		expect(JSON.stringify(loggedExtension[0].metadata)).not.toContain(TOKEN);

		const group = configIgnoredGroup();
		expect(group?.latestReasons[0]?.reason).not.toContain(TOKEN);
	});
});

/**
 * #2451: after #2431's fix, the position-free `Unexpected token` shape (the
 * exact one #2431's own evidence hit) degraded to a bare `SyntaxError` — LESS
 * locality than a hand-editing user had before #2431. `normalizeParseErrorReason`
 * now accepts the source text the loaders already hold and locates the error
 * IN IT, so `line L col C` survives for this shape too — derived from the
 * source by scanning it, never by trusting a digit or a snippet straight out
 * of the message.
 */
describe("normalizeParseErrorReason locates a position-free SyntaxError in its source (#2451)", () => {
	const TOKEN = `ghp_${"A".repeat(36)}`;

	function realJsonParseError(content: string): SyntaxError {
		try {
			JSON.parse(content);
		} catch (error) {
			if (error instanceof SyntaxError) return error;
			throw error;
		}
		throw new Error("expected JSON.parse to throw for this fixture");
	}

	it("recovers line/col for a single-line document, only digits escape", () => {
		const content = `{"piToken": ${TOKEN}}`;
		const error = realJsonParseError(content);
		// Pre-#2451 (no sourceText): bare class name, no locality at all — the
		// exact regression this issue reports.
		expect(normalizeParseErrorReason(error)).toBe("SyntaxError");

		const reason = normalizeParseErrorReason(error, { sourceText: content });
		expect(reason).toBe("SyntaxError at line 1 col 13");
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("ghp_");
		expect(reason).not.toContain("piToken");
	});

	it("recovers the correct LINE across a multi-line document, not just the correct file", () => {
		const content = `{\n  "a": 1,\n  "piToken": ${TOKEN}\n}`;
		const error = realJsonParseError(content);
		const reason = normalizeParseErrorReason(error, { sourceText: content });
		expect(reason).toBe("SyntaxError at line 3 col 14");
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("ghp_");
	});

	it("still recomputes line/col from the source for the position-stated shape, not from the message", () => {
		// `{` alone: V8 states `at position 1 (line 1 column 2)`. With source
		// text, the position is derived by SCANNING the source at offset 1,
		// never by trusting the digits V8 put in its own message text.
		const content = "{";
		const error = realJsonParseError(content);
		expect(normalizeParseErrorReason(error, { sourceText: content })).toBe(
			"SyntaxError at line 1 col 2",
		);
	});

	it("falls back to the bare class name when the snippet is not a unique match in the source", () => {
		// A synthetic message in V8's exact position-free shape. `sourceText`
		// contains the quoted snippet TWICE — the located position would be a
		// coin flip, so the safe answer is no location at all, not a guess.
		const error = {
			name: "SyntaxError",
			message: `Unexpected token 'w', "hello world" is not valid JSON`,
		};
		const sourceText = "hello world, and also: hello world again";
		expect(normalizeParseErrorReason(error, { sourceText })).toBe(
			"SyntaxError",
		);
	});

	it("degrades to the snippet's own start when the offending token repeats inside it", () => {
		// Snippet ("hello world") is UNIQUE in the source, but the token 'o'
		// inside it is not (it appears in both "hello" and "world"), so the
		// exact character cannot be picked out — the snippet's own (unambiguous)
		// start position stands in, still the correct line.
		const error = {
			name: "SyntaxError",
			message: `Unexpected token 'o', "hello world" is not valid JSON`,
		};
		const sourceText = "xxx hello world yyy";
		// snippet starts at index 4 -> line 1, col 5.
		expect(normalizeParseErrorReason(error, { sourceText })).toBe(
			"SyntaxError at line 1 col 5",
		);
	});

	it("does not misparse a message that only superficially resembles the shape", () => {
		const notReallyThatShape = {
			name: "SyntaxError",
			message: "Unexpected token missing the quoted snippet entirely",
		};
		expect(
			normalizeParseErrorReason(notReallyThatShape, { sourceText: "anything" }),
		).toBe("SyntaxError");
	});

	it("requires the shape at the START of the message, not merely present somewhere in it", () => {
		// A hand-authored `name: "SyntaxError"` object (not a real JSON.parse
		// error at all) whose message happens to CONTAIN this shape's marker
		// after some other prefix text. Locating a snippet from unrelated,
		// caller-controlled prose is not this function's contract.
		const notFromJsonParse = {
			name: "SyntaxError",
			message: `zzzzz Unexpected token 'q', "hello" is not valid JSON`,
		};
		expect(
			normalizeParseErrorReason(notFromJsonParse, {
				sourceText: "xxx hello yyy",
			}),
		).toBe("SyntaxError");
	});

	it("requires the message to end in one of V8's two known suffixes, not just be quoted", () => {
		// Properly quoted, but the tail is neither `" is not valid JSON` nor
		// `"... is not valid JSON` — not a shape this function recognizes, so it
		// must not guess a snippet out of whatever text happens to follow.
		const unknownTail = {
			name: "SyntaxError",
			message: `Unexpected token 'q', "hello" this is a weird ending`,
		};
		expect(
			normalizeParseErrorReason(unknownTail, {
				sourceText: `xxx hello" this is a weird ending yyy`,
			}),
		).toBe("SyntaxError");
	});

	it("requires the snippet to actually be quoted, not just followed by a trailing suffix", () => {
		// The marker (`', `) is present and the message DOES end with the
		// "is not valid JSON" suffix, but there is no opening `"` — V8 never
		// emits that shape, so this is not a real snippet to trust.
		const noOpeningQuote = {
			name: "SyntaxError",
			message: `Unexpected token 'q', Xhello" is not valid JSON`,
		};
		expect(
			normalizeParseErrorReason(noOpeningQuote, {
				sourceText: "xxx hello yyy",
			}),
		).toBe("SyntaxError");
	});

	it("classOnly overrides source-derived locality too, for a SyntaxError", () => {
		const content = `{"piToken": ${TOKEN}}`;
		const error = realJsonParseError(content);
		const reason = normalizeParseErrorReason(error, {
			sourceText: content,
			classOnly: true,
		});
		expect(reason).toBe("SyntaxError");
	});

	it("classOnly strips the message from a non-SyntaxError too — config-core's own guarantee (#2451)", () => {
		const error = new TypeError(`unexpected value ${TOKEN}`);
		const reason = normalizeParseErrorReason(error, { classOnly: true });
		expect(reason).toBe("TypeError");
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("unexpected value");
		// Contrast with the DEFAULT (non-classOnly) behavior for the same error:
		// this is the one branch where the (redacted) message DOES survive —
		// proof `classOnly` is doing real work, not a no-op flag.
		expect(normalizeParseErrorReason(error)).toContain("unexpected value");
	});

	it("warnIgnoredConfigOnce threads sourceText through to recover locality end to end", () => {
		const content = `{"piToken": ${TOKEN}}`;
		const error = realJsonParseError(content);

		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/.pi-lens.json",
			reason: { parseError: error, sourceText: content },
		});

		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"ignoring invalid project config /tmp/.pi-lens.json: SyntaxError at line 1 col 13",
		);
		expect(notified[0].message).not.toContain(TOKEN);
		expect(notified[0].message).not.toContain("ghp_");

		const group = configIgnoredGroup();
		expect(group?.latestReasons[0]?.reason).toBe(
			"SyntaxError at line 1 col 13",
		);
	});
});
