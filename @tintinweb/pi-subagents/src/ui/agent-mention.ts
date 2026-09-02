/**
 * agent-mention.ts — what `@` can address, and the suggestions pi renders for it.
 *
 * A subagent is addressable whether or not it is currently running: a live
 * record is messaged or resumed, an evicted one whose session is still on disk
 * is reopened, and an agent *type* with no instance at all is started. That is
 * the point of the handle — `@explore` means the Explore agent, not "the
 * Explore process that happens to exist right now" — so the roster below unions
 * all three, and the dispatcher and the popup read the same list.
 *
 * Rows are per *agent*, not per handle. An agent given a `name` holds two names
 * (its alias and its type-derived handle) and both resolve, but it lists once,
 * under the alias, with its type moved into the description so the row still
 * says what it is.
 *
 * pi's `CombinedAutocompleteProvider` already owns `@`, where it means "attach a
 * file". Extensions can wrap it (`ctx.ui.addAutocompleteProvider`), so this
 * provider adds the `@` tokens that name an agent and delegates everything else
 * — including all of `applyCompletion`, whose `@`-branch already inserts
 * `item.value` plus a trailing space, which is exactly what a handle needs.
 *
 * Matching mirrors Claude Code: case-insensitive prefix, not fuzzy. What it does
 * NOT mirror is Claude Code dropping files whenever an agent matches. Here `@` is
 * pi's file picker first, and the handles are additive, so a token matching both
 * lists both — agents first. Suppressing on any match sounds narrow and is not:
 * an empty token prefix-matches every handle, so a bare `@` — the gesture people
 * use to browse files — would offer no files at all, and a single letter
 * beginning any handle would do the same.
 *
 * Both halves ship under ONE `prefix`, which is sound because wherever BOTH sides
 * produce rows they measured the same span. pi's `extractAtPrefix` takes the
 * token after the last of `{space, tab, ", ', =}` and keeps it only if it starts
 * with `@`; `MENTION_TRIGGER` matches `@[\w-]*` at the cursor, after start-of-line
 * or `[\s。、？！]`. Where those two disagree, exactly one side answers and there
 * is nothing to merge: `@src/index.ts` and `@"my file` are pi's alone (no handle
 * matches), `=@ex` is pi's alone (`=` is a delimiter to pi, not a boundary to us),
 * and `。@ex` is ours alone (the reverse). A merged response therefore never
 * carries a prefix from one side and an item from the other.
 *
 * Offering never-started types is a deliberate step beyond Claude Code, whose
 * registry holds only live tasks, so an agent you had not launched yet was
 * unaddressable.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { handleBase, MENTION_TRIGGER } from "../mention.js";
import type { AgentRecord, AgentTombstone } from "../types.js";

/**
 * One thing `@` can address, and what sending to it will do. `typeLabel` is the
 * agent's `display_name`, resolved by the caller: this module stays independent
 * of the type registry, but the popup must agree with FleetView and the widget,
 * which both render the label rather than the raw type.
 */
export type MentionTarget =
  | { kind: "record"; handle: string; record: AgentRecord; typeLabel: string }
  | { kind: "tombstone"; handle: string; entry: AgentTombstone; typeLabel: string }
  | { kind: "type"; handle: string; type: string; description: string };

/** The registry facts the roster needs, so it stays independent of agent-types. */
export type TypeInfo = { name: string; description: string };

/**
 * Everything `@` can reach, in the order the popup lists it: steerable agents
 * first, then the other live ones earliest-launched, then agent types with no
 * live instance. A type whose handle a record already holds is omitted — that
 * name addresses the existing agent, which is what makes `@explore` mean
 * "message the one that's running" and only otherwise "start one".
 */
export function mentionRoster(
  manager: AgentManager,
  types: readonly TypeInfo[],
  // Identity by default: a caller with no registry to consult gets the raw
  // type, which is also what `getConfig` falls back to when no label is set.
  displayNameOf: (type: string) => string = type => type,
): MentionTarget[] {
  const live = (r: AgentRecord) => r.status === "running" || r.status === "queued";
  const records = manager.listAgents()
    .filter(r => r.handle !== undefined && r.parentAgentId === undefined)
    .sort((a, b) => (Number(live(b)) - Number(live(a))) || (a.startedAt - b.startedAt));

  const taken = new Set<string>();
  const targets: MentionTarget[] = [];

  // One row per agent, not per handle. An aliased agent lists under its alias
  // only — both names resolve, but showing two rows for one agent reads as two
  // agents. The type handle stays addressable whether or not it is listed.
  for (const record of records) {
    const handle = record.alias ?? record.handle!;
    taken.add(handle.toLowerCase());
    if (record.handle) taken.add(record.handle.toLowerCase());
    targets.push({ kind: "record", handle, record, typeLabel: displayNameOf(record.type) });
  }

  // Then agents that are gone but whose conversation can be reopened. After the
  // live ones: a running agent is the likelier target, and this keeps the
  // ordering "what exists now, then what can be brought back, then what can be
  // started".
  for (const entry of manager.listTombstones()) {
    const handle = entry.alias ?? entry.handle;
    if (taken.has(handle.toLowerCase())) continue;
    taken.add(handle.toLowerCase());
    taken.add(entry.handle.toLowerCase());
    targets.push({ kind: "tombstone", handle, entry, typeLabel: displayNameOf(entry.type) });
  }

  for (const type of types) {
    const handle = handleBase(type.name);
    if (taken.has(handle)) continue;
    taken.add(handle);
    targets.push({ kind: "type", handle, type: type.name, description: type.description });
  }
  return targets;
}

export function createMentionProvider(
  current: AutocompleteProvider,
  roster: () => MentionTarget[],
  isEnabled: () => boolean,
): AutocompleteProvider {
  // One warning per provider, not per keystroke: `getSuggestions` runs on every
  // character typed after `@`, so an unguarded log would bury the terminal in
  // the time it takes to finish a word.
  let warnedInnerFailure = false;
  return {
    // Only `@` — the contract is "characters that should naturally trigger
    // THIS provider", and pi unions each wrapper's own set onto the outermost
    // one itself (interactive-mode.js:432), so re-declaring the wrapped
    // provider's characters here would both misreport us and duplicate that.
    triggerCharacters: ["@"],

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const mine = isEnabled() ? mentionItems(roster(), lines[cursorLine] ?? "", cursorCol) : null;
      // Asked unconditionally: pi owns `@` and must keep answering for it even
      // when a handle matches too. That is the same work vanilla pi does on any
      // `@` keystroke — a capped `fd` search, or nothing at all when the host
      // configured no `fd` path — but we now do it on tokens we used to answer
      // alone, so it must not be able to take the popup down with it. The
      // wrapped provider is not always pi's: another extension may sit inside
      // us, and before this it was never called for a token naming an agent.
      // try/catch, not `.catch()`: a provider that throws SYNCHRONOUSLY never
      // returns the promise a `.catch()` would attach to, and the throw escapes
      // this method as a rejection — which pi does not handle either
      // (components/editor.js:1892 awaits with no catch of its own).
      let theirs: AutocompleteSuggestions | null = null;
      try {
        theirs = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch (err) {
        // Safe to treat as "no files": pi discards any response whose request is
        // no longer current, so an aborted search that surfaces as a rejection
        // cannot leave a stale popup behind (`isAutocompleteRequestCurrent`).
        // Warned rather than swallowed outright — the failure is invisible in
        // the popup, and the same `console.warn` channel already carries this
        // extension's other non-fatal failures.
        if (!warnedInnerFailure) {
          warnedInnerFailure = true;
          console.warn("[pi-subagents] the autocomplete provider below us failed; showing agent rows only:", err);
        }
        theirs = null;
      }
      if (!mine) return theirs;
      if (!theirs) return mine;
      // Agents first: there are a handful of them against pi's 20 file rows, and
      // a handle buried under fuzzy path matches is a handle nobody finds. The
      // prefix is ours by the span argument in the header — identical to pi's
      // whenever both sides have something to say.
      return { items: [...mine.items, ...theirs.items], prefix: mine.prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** Suggestions for the `@…` token under the cursor, or null when it names no agent. */
function mentionItems(roster: MentionTarget[], line: string, cursorCol: number): AutocompleteSuggestions | null {
  const match = MENTION_TRIGGER.exec(line.slice(0, cursorCol));
  if (!match) return null;

  const typed = match[2].toLowerCase();
  const items: AutocompleteItem[] = [];
  for (const target of roster) {
    if (!target.handle.toLowerCase().startsWith(typed)) continue;
    items.push({ value: `@${target.handle}`, label: `@${target.handle}`, description: describeTarget(target) });
  }
  return items.length > 0 ? { items, prefix: `@${match[2]}` } : null;
}

/** Name the action that will actually happen, so the list never mispromises. */
function describeTarget(target: MentionTarget): string {
  if (target.kind === "type") return `start agent · ${summarize(target.description)}`;
  if (target.kind === "tombstone") {
    // No status: the record is gone, and "completed" would imply one is still
    // being tracked. The type carries the identity the handle may not.
    return `resume · ${target.typeLabel} · ${target.entry.description}`;
  }
  const { status, description, alias } = target.record;
  const action = status === "running" || status === "queued" ? "send message" : "resume";
  // A row listed under its alias has lost the type its handle would have shown,
  // so name it — `@auth-audit` alone says nothing about what the agent is.
  // A type-derived row already reads as its type and would just repeat itself.
  const identity = alias ? `${target.typeLabel} · ` : "";
  return `${action} · ${identity}${status} · ${description}`;
}

/** First sentence of an agent description, clipped — these run to paragraphs. */
function summarize(description: string): string {
  const first = (description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description).replace(/\s+/g, " ").trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}
