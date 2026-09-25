import { findFirstMatchForNames } from "./common.js";

export type CompiledWildcardPattern<TState> = {
  pattern: string;
  state: TState;
  regex: RegExp;
};

export type WildcardPatternMatch<TState> = {
  state: TState;
  matchedPattern: string;
  matchedName: string;
};

/** Maximum length for a wildcard permission pattern. Bounds regex compilation work and blocks oversized config values from causing slow regex evaluation. */
const MAX_WILDCARD_PATTERN_LENGTH = 500;

const NEVER_MATCH_PATTERN = /$^/;

export function compileWildcardPattern<TState>(pattern: string, state: TState): CompiledWildcardPattern<TState> {
  if (pattern.length > MAX_WILDCARD_PATTERN_LENGTH) {
    return {
      pattern,
      state,
      regex: NEVER_MATCH_PATTERN,
    };
  }
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  return {
    pattern,
    state,
    regex: new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s"), // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — pattern is a config-provided wildcard that is length-bounded (<=MAX_WILDCARD_PATTERN_LENGTH) and escaped (only `*`/`?` become `.*`/`.`); no user input reaches the regex engine.
  };
}

export function compileWildcardPatternEntries<TState>(
  entries: Iterable<readonly [string, TState]>,
): CompiledWildcardPattern<TState>[] {
  return Array.from(entries, ([pattern, state]) => compileWildcardPattern(pattern, state));
}

export function compileWildcardPatterns<TState>(
  patterns: Record<string, TState>,
): CompiledWildcardPattern<TState>[] {
  return compileWildcardPatternEntries(Object.entries(patterns));
}

export function findCompiledWildcardMatch<TState>(
  patterns: readonly CompiledWildcardPattern<TState>[],
  name: string,
): WildcardPatternMatch<TState> | null {
  const normalizedName = name.replaceAll("\\", "/");
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    if (pattern.regex.test(normalizedName)) {
      return {
        state: pattern.state,
        matchedPattern: pattern.pattern,
        matchedName: name,
      };
    }
  }

  return null;
}

export function findCompiledWildcardMatchForNames<TState>(
  patterns: readonly CompiledWildcardPattern<TState>[],
  names: readonly string[],
): WildcardPatternMatch<TState> | null {
  return findFirstMatchForNames(names, (name) => findCompiledWildcardMatch(patterns, name));
}
