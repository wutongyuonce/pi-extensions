/**
 * agent-mention-provider.test.ts — the `@handle` suggestions stacked on pi's
 * built-in autocomplete.
 *
 * The provider sits in front of file completion and must not take it away: `@`
 * still means "attach a file" in pi, and agents are additive, so a token that
 * matches both lists them both — agents first, then pi's rows, under one
 * `prefix`. The risks are at the seam: dropping pi's list when an agent matches
 * (which is what made a bare `@` stop offering files), inserting the wrong span
 * because the two providers disagreed about the token, and claiming a token that
 * was only ever a path. Every case below pins one of those.
 */
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord, AgentTombstone } from "../src/types.js";
import { createMentionProvider, mentionRoster } from "../src/ui/agent-mention.js";

const FILE_SUGGESTIONS = { items: [{ value: "@src/index.ts", label: "src/index.ts" }], prefix: "@src/" };

/** A stand-in for pi's CombinedAutocompleteProvider. */
function builtIn() {
  return {
    triggerCharacters: ["@", "#"],
    getSuggestions: vi.fn().mockResolvedValue(FILE_SUGGESTIONS),
    applyCompletion: vi.fn().mockReturnValue({ lines: ["applied"], cursorLine: 0, cursorCol: 7 }),
    shouldTriggerFileCompletion: vi.fn().mockReturnValue(false),
  };
}

function record(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: `id-${over.handle}`,
    type: "Explore",
    description: "find flaky tests",
    status: "running",
    toolUses: 0,
    startedAt: 1000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function managerWith(...records: AgentRecord[]): AgentManager {
  // listAgents() is newest-first, matching the real manager's contract.
  return {
    listAgents: () => [...records].sort((a, b) => b.startedAt - a.startedAt),
    listTombstones: () => [],
  } as unknown as AgentManager;
}

/** A manager holding only evicted agents, to exercise the resume rows. */
function managerWithTombstones(...entries: AgentTombstone[]): AgentManager {
  return {
    listAgents: () => [],
    listTombstones: () => [...entries].sort((a, b) => b.completedAt - a.completedAt),
  } as unknown as AgentManager;
}

function tombstone(over: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle: "explore",
    id: "t1",
    type: "Explore" as AgentTombstone["type"],
    description: "audit the RPC path",
    sessionFile: "/sessions/explore.jsonl",
    completedAt: 5000,
    ...over,
  };
}

/** Ask for suggestions on a single line, cursor at the end. */
const suggest = (provider: ReturnType<typeof createMentionProvider>, line: string) =>
  provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

/**
 * Just the rows we contributed. pi's stub rows are dropped by identity, so a
 * test about handle ordering stays about handle ordering — without pretending
 * no file matched, which is the state that hid this bug in the first place.
 */
const agentRows = (result: Awaited<ReturnType<typeof suggest>>) =>
  (result?.items ?? []).filter(item => !(FILE_SUGGESTIONS.items as unknown[]).includes(item));

describe("agent suggestions", () => {
  it("lists matching handles above pi's files rather than instead of them", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    const result = await suggest(provider, "@ex");

    expect(result).toEqual({
      items: [
        { value: "@explore", label: "@explore", description: "send message · running · find flaky tests" },
        ...FILE_SUGGESTIONS.items,
      ],
      // Ours, not the stub's: when both match, both describe the same span (see
      // the real-provider describe below), and ours is the authority on where
      // the handle token starts.
      prefix: "@ex",
    });
    // Verbatim: the inner provider has to see the same line, cursor and options
    // the editor handed us, or its rows describe a different token than ours.
    expect(current.getSuggestions).toHaveBeenCalledWith(["@ex"], 0, 3, expect.objectContaining({ signal: expect.anything() }));
  });

  it("offers every agent on a bare @, and still offers files", async () => {
    // The regression this file exists for: an empty token prefix-matches EVERY
    // handle, so suppressing files "when an agent matches" suppressed them on
    // the one gesture people use to browse — `@` alone.
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore" }), record({ handle: "plan", startedAt: 2000 })), []),
      () => true,
    );

    const result = await suggest(provider, "@");

    expect(result?.items.map(i => i.value)).toEqual(["@explore", "@plan", "@src/index.ts"]);
  });

  it("offers agents alone when no file matched", async () => {
    const current = builtIn();
    current.getSuggestions.mockResolvedValue(null);
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("still offers agents when the wrapped provider throws", async () => {
    // We now call the inner provider for tokens we used to answer alone, and it
    // is not always pi's — an extension registered before us sits inside. A
    // rejection there must not delete the handle rows too.
    const current = builtIn();
    current.getSuggestions.mockRejectedValue(new Error("inner provider exploded"));
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("still offers agents when the wrapped provider throws synchronously", async () => {
    // The async case above is caught by any `.catch()`; this one is not — a sync
    // throw never yields a promise to attach to, so only try/catch holds it.
    const current = builtIn();
    current.getSuggestions.mockImplementation(() => { throw new Error("sync boom"); });
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("warns once about a failing inner provider, not once per keystroke", async () => {
    // getSuggestions runs on every character after `@`; a log per call would
    // bury the terminal. But swallowing it silently leaves a broken provider
    // with no trace anywhere, since the popup just looks file-less.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const current = builtIn();
      current.getSuggestions.mockRejectedValue(new Error("inner provider exploded"));
      const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

      for (const line of ["@e", "@ex", "@exp"]) await suggest(provider, line);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[pi-subagents]");
    } finally {
      warn.mockRestore();
    }
  });

  it("returns pi's list untouched when no agent exists at all", async () => {
    const provider = createMentionProvider(builtIn(), () => [], () => true);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("puts steerable agents first, then earliest-launched", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(
        record({ handle: "explore", status: "completed", startedAt: 1000 }),
        record({ handle: "explore-3", status: "running", startedAt: 3000 }),
        record({ handle: "explore-2", status: "running", startedAt: 2000 }),
      ), []),
      () => true,
    );

    const result = await suggest(provider, "@ex");

    expect(agentRows(result).map(i => i.value)).toEqual(["@explore-2", "@explore-3", "@explore"]);
  });

  it("matches case-insensitively", async () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(agentRows(await suggest(provider, "@EX")).map(i => i.value)).toEqual(["@explore"]);
  });

  it("completes a mention typed mid-message", async () => {
    // The trigger fires at any token boundary, even though only a LEADING
    // mention is actually sent — same split as Claude Code.
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect((await suggest(provider, "ask @ex"))?.prefix).toBe("@ex");
  });
});

describe("agents that have never run", () => {
  const TYPES = [
    { name: "Explore", description: "Fast codebase exploration. Read-only, medium breadth." },
    { name: "code-review", description: "Reviews a diff." },
  ];

  it("offers a registered type with no live instance, and says it will start one", async () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(), TYPES), () => true);

    const result = await suggest(provider, "@ex");

    expect(agentRows(result)).toEqual([{
      value: "@explore",
      label: "@explore",
      description: "start agent · Fast codebase exploration.",
    }]);
    // Kept from before the merge: the span the rows are inserted over is the
    // typed token, not the stub's "@src/".
    expect(result?.prefix).toBe("@ex");
  });

  it("lets a live agent own its handle instead of listing the type twice", async () => {
    // `@explore` has to mean the running Explore, or the mention would start a
    // second one while the first is mid-task.
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore" })), TYPES),
      () => true,
    );

    const result = await suggest(provider, "@ex");

    expect(agentRows(result).map(i => i.value)).toEqual(["@explore"]);
    expect(agentRows(result)[0].description).toBe("send message · running · find flaky tests");
  });

  it("still offers the type once its only instance has finished, as a resume", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", status: "completed" })), TYPES),
      () => true,
    );

    expect((await suggest(provider, "@ex"))?.items[0].description)
      .toBe("resume · completed · find flaky tests");
  });

  it("lists live agents before startable types", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "plan" })), TYPES),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@")).map(i => i.value))
      .toEqual(["@plan", "@explore", "@code-review"]);
  });
});

describe("delegation to pi's provider", () => {
  it("delegates when no handle matches the typed prefix", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@zz")).toBe(FILE_SUGGESTIONS);
    expect(current.getSuggestions).toHaveBeenCalled();
  });

  it("delegates a path-shaped token even when its first segment names an agent", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@explore/notes.md")).toBe(FILE_SUGGESTIONS);
    expect(current.getSuggestions).toHaveBeenCalled();
  });

  it("delegates an @ that is not at a token boundary", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "mail@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("never claims nested children — nothing can address them", async () => {
    const current = builtIn();
    const nested = record({ handle: "explore", parentAgentId: "parent-1" });
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(nested), []), () => true);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("delegates everything while mentions are disabled", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => false);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });
});

describe("composing with another extension's provider", () => {
  // pi folds every registered wrapper over the base provider in registration
  // order (interactive-mode.js:428), so an extension is either inside us or
  // outside us depending on load order. Both directions have to work, and
  // neither is under our control.
  const TYPES = [{ name: "Explore", description: "Fast codebase exploration." }];

  /** A foreign wrapper that owns `#` and delegates everything else. */
  function hashWrapper(current: any) {
    return {
      triggerCharacters: ["#"],
      getSuggestions: vi.fn(async (lines: string[], line: number, col: number, opts: any) =>
        /(^|\s)#\w*$/.test(lines[line].slice(0, col))
          ? { items: [{ value: "#general", label: "#general" }], prefix: "#" }
          : current.getSuggestions(lines, line, col, opts)),
      applyCompletion: vi.fn((...args: any[]) => (current.applyCompletion as any)(...args)),
    };
  }

  it("delegates to a provider registered before us", async () => {
    const base = builtIn();
    const provider = createMentionProvider(
      hashWrapper(base) as any,
      () => mentionRoster(managerWith(), TYPES),
      () => true,
    );

    // ours wins for @, the inner wrapper still owns #, files still reach base
    expect(agentRows(await suggest(provider, "@ex")).map(i => i.value)).toEqual(["@explore"]);
    expect((await suggest(provider, "#gen"))?.items.map(i => i.value)).toEqual(["#general"]);
    expect(await suggest(provider, "@src/")).toBe(FILE_SUGGESTIONS);
  });

  it("is still reachable through a provider registered after us", async () => {
    const base = builtIn();
    const ours = createMentionProvider(base, () => mentionRoster(managerWith(), TYPES), () => true);
    const outer = hashWrapper(ours) as any;

    expect(agentRows(await outer.getSuggestions(["@ex"], 0, 3, { signal: new AbortController().signal }))
      .map(i => i.value)).toEqual(["@explore"]);
    expect((await outer.getSuggestions(["#g"], 0, 2, { signal: new AbortController().signal }))
      ?.items.map((i: any) => i.value)).toEqual(["#general"]);
  });

  it("lets pi union the chain's trigger characters, as it already does", () => {
    // Replicates setupAutocompleteProvider (interactive-mode.js:428): pi folds
    // the wrappers over the base, collecting each one's OWN characters, then
    // stamps the union on the outermost. Declaring the inner set ourselves
    // would duplicate that and misreport what we handle.
    const wrappers = [
      (current: any) => hashWrapper(current),
      (current: any) => createMentionProvider(current, () => mentionRoster(managerWith(), TYPES), () => true),
    ];
    let provider: any = builtIn();
    const collected: string[] = [];
    for (const wrap of wrappers) {
      provider = wrap(provider);
      collected.push(...(provider.triggerCharacters ?? []));
    }

    expect(provider.triggerCharacters).toEqual(["@"]);   // ours declares only @
    expect([...new Set(collected)]).toEqual(["#", "@"]); // pi still ends up with both
  });

  it("can be rebuilt from the same factory without accumulating state", () => {
    // Every later addAutocompleteProvider call re-runs the whole chain from a
    // fresh base, so our factory is invoked again each time.
    const roster = () => mentionRoster(managerWith(record({ handle: "explore" })), []);
    const first = createMentionProvider(builtIn(), roster, () => true);
    const second = createMentionProvider(builtIn(), roster, () => true);

    expect(second.triggerCharacters).toEqual(first.triggerCharacters);
  });
});

describe("against pi's real provider", () => {
  // The mocks above pin our own branching; these pin the contract itself, by
  // handing our items and prefix to the actual CombinedAutocompleteProvider.
  // Getting `prefix` wrong by a character silently eats input on completion.
  const real = () => new CombinedAutocompleteProvider([], process.cwd(), null);
  const provider = () =>
    createMentionProvider(real(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

  it("inserts the handle and a trailing space at the start of a line", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;

    expect(p.applyCompletion(["@ex"], 0, 3, suggestions.items[0], suggestions.prefix)).toEqual({
      lines: ["@explore "],
      cursorLine: 0,
      cursorCol: 9,
    });
  });

  it("replaces only the mention token when it sits mid-line", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "ask @ex"))!;

    expect(p.applyCompletion(["ask @ex"], 0, 7, suggestions.items[0], suggestions.prefix)).toEqual({
      lines: ["ask @explore "],
      cursorLine: 0,
      cursorCol: 13,
    });
  });

  it("keeps text after the cursor intact", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;

    expect(p.applyCompletion(["@ex please"], 0, 3, suggestions.items[0], suggestions.prefix).lines)
      .toEqual(["@explore  please"]);
  });

  it("inserts a FILE-shaped row from OUR prefix, character for character", async () => {
    // The merge ships both kinds of row under one `prefix`, so pi's real
    // applyCompletion has to land a path from a span our regex measured. Off by
    // one and it eats a character or leaves an `@` behind — silently.
    //
    // The file row is synthesized rather than discovered: pi's
    // getFuzzyFileSuggestions returns [] the moment `fdPath` is null
    // (pi-tui/dist/autocomplete.js:577), which is how every real-provider test
    // here constructs it, and `fd` cannot be assumed on CI. What that leaves
    // unverified is only pi's own token scan — `extractAtPrefix` takes the whole
    // token after the last delimiter, and we only ever claim tokens of `[\w-]`,
    // so the two spans cannot disagree where both produce rows.
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;
    const fileRow = { value: "@examples/agent-tool-description.md", label: "agent-tool-description.md" };

    expect(p.applyCompletion(["@ex"], 0, 3, fileRow, suggestions.prefix).lines)
      .toEqual(["@examples/agent-tool-description.md "]);
    expect(p.applyCompletion(["ask @ex now"], 0, 7, fileRow, suggestions.prefix).lines)
      .toEqual(["ask @examples/agent-tool-description.md  now"]);
  });

  it("declares a trigger character the editor will actually accept", () => {
    // editor.js:1851 drops multi-char entries, "/" and whitespace silently.
    for (const character of provider().triggerCharacters ?? []) {
      expect(character.length).toBe(1);
      expect(character).not.toBe("/");
      expect(character.trim()).toBe(character);
    }
  });
});

describe("insertion and trigger plumbing", () => {
  it("hands applyCompletion to pi — its @-branch already inserts value plus a space", () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(), []), () => true);
    const item = { value: "@explore", label: "@explore" };

    expect(provider.applyCompletion(["@ex"], 0, 3, item, "@ex")).toEqual({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    });
    expect(current.applyCompletion).toHaveBeenCalledWith(["@ex"], 0, 3, item, "@ex");
  });

  it("keeps pi's file-completion gate rather than forcing it open", () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(), []), () => true);

    expect(provider.shouldTriggerFileCompletion?.(["/model"], 0, 6)).toBe(false);
  });

  it("declares @ and nothing else", () => {
    // `#` is pi's other default trigger, not ours — and the editor seeds its
    // own set from DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS (editor.js:1849)
    // and only adds, so claiming it here would gain nothing and mean nothing.
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(), []), () => true);

    expect(provider.triggerCharacters).toEqual(["@"]);
  });
});

describe("named agents and evicted ones", () => {
  it("lists a named agent once, under its alias, and says what type it is", async () => {
    // Two rows for one agent would read as two agents; and `@auth-audit`
    // alone says nothing about what it is, which the handle used to carry.
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running", description: "audit the auth flow" })), []),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@"))).toEqual([
      { value: "@auth-audit", label: "@auth-audit", description: "send message · Explore · running · audit the auth flow" },
    ]);
  });

  it("leaves an unnamed agent's row free of a redundant type", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", type: "Explore", status: "running", description: "find flaky tests" })), []),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description).toBe("send message · running · find flaky tests");
  });

  it("still resolves the unlisted type handle of a named agent", () => {
    // The row shows the alias, but `@explore` must keep reaching this agent —
    // that is what stops it from starting a second Explore.
    const roster = mentionRoster(
      managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running" })),
      [{ name: "Explore", description: "search" }],
    );

    // The type is NOT offered as startable: its handle belongs to the live agent.
    expect(roster.map(t => t.handle)).toEqual(["auth-audit"]);
  });

  it("offers an evicted agent as a resume, after the live ones", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), []),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@"))).toEqual([
      { value: "@explore", label: "@explore", description: "resume · Explore · audit the RPC path" },
    ]);
  });

  it("puts live agents ahead of resumable ones", async () => {
    // A running agent is the likelier target, and a resume is the slower,
    // more surprising action to land on by pressing Enter too quickly.
    const manager = {
      listAgents: () => [record({ handle: "plan", type: "Plan", status: "running" })],
      listTombstones: () => [tombstone()],
    } as unknown as AgentManager;
    const provider = createMentionProvider(builtIn(), () => mentionRoster(manager, []), () => true);

    expect(agentRows(await suggest(provider, "@")).map(i => i.value)).toEqual(["@plan", "@explore"]);
  });

  it("keeps an aliased tombstone's type handle reserved too", () => {
    // It lists under its alias, but `@explore` still resumes it — so the
    // Explore type must not also be offered as startable under that name.
    const roster = mentionRoster(
      managerWithTombstones(tombstone({ handle: "explore", alias: "auth-audit" })),
      [{ name: "Explore", description: "search" }],
    );

    expect(roster.map(t => t.handle)).toEqual(["auth-audit"]);
  });

  it("does not offer a startable type whose handle a tombstone still holds", () => {
    // `@explore` resumes the old conversation, so advertising "start agent"
    // under the same name would promise the wrong action.
    const roster = mentionRoster(managerWithTombstones(tombstone()), [{ name: "Explore", description: "search" }]);

    expect(roster).toHaveLength(1);
    expect(roster[0].kind).toBe("tombstone");
  });
});

// FleetView, the widget, the tool header and the conversation viewer all render
// `display_name` (via getConfig). The popup rendering the raw type instead would
// make `@` the one surface that calls the same agent something else.
describe("rows carry the display name, not the raw type", () => {
  const label = (type: string) => (type === "Explore" ? "Auth Auditor" : type);

  it("names an aliased agent by its label", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(
        managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running", description: "audit the auth flow" })),
        [],
        label,
      ),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description)
      .toBe("send message · Auth Auditor · running · audit the auth flow");
  });

  it("names a resumable agent by its label", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), [], label),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description)
      .toBe("resume · Auth Auditor · audit the RPC path");
  });

  it("falls back to the raw type when no resolver is supplied", async () => {
    // Which is also what getConfig does for an agent with no display_name, so
    // the default keeps a caller without a registry honest rather than blank.
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), []),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description).toContain("· Explore ·");
  });
});
