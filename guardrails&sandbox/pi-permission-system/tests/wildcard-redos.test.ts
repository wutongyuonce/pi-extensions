// TDD coverage for Semgrep detect-non-literal-regexp in wildcard-matcher.ts.
// Run with: bun ./tests/wildcard-redos.test.ts
import assert from "node:assert/strict";
import { runTest } from "./test-harness.js";
import { compileWildcardPattern, findCompiledWildcardMatch } from "../src/wildcard-matcher.js";
import type { WildcardPatternMatch } from "../src/wildcard-matcher.js";
import type { PermissionState } from "../src/types.js";

// Normal behavior must still work after hardening.
runTest("REDOS-NR: compileWildcardPattern matches normal wildcard patterns", () => {
  const pattern = compileWildcardPattern("git *", "allow" as PermissionState);
  assert.ok(pattern.regex.test("git status"), "git * should match git status");
  assert.ok(pattern.regex.test("git"), "git * should match bare git");
  assert.equal(pattern.regex.test("npm install"), false, "git * should not match npm install");
});

runTest("REDOS-NR: findCompiledWildcardMatch returns the last matching pattern", () => {
  const patterns = [
    compileWildcardPattern("git *", "allow" as PermissionState),
    compileWildcardPattern("git push *", "deny" as PermissionState),
  ];
  const match = findCompiledWildcardMatch(patterns, "git push origin");
  assert.ok(match, "expected a match");
  assert.equal(match?.state, "deny", "last-match-wins should select the deny rule");
});

// RED: compileWildcardPattern must safely handle an oversized pattern without throwing.
// The pattern input comes from user-configured permission rules; an attacker or
// misconfigured config could supply an oversized pattern. The matcher must fail safe
// (not match) rather than throw or catastrophically backtrack.
runTest("REDOS-TDD: compileWildcardPattern safely rejects oversized patterns without throwing", () => {
  const oversized = "a".repeat(600);
  let pattern: ReturnType<typeof compileWildcardPattern<PermissionState>>;
  assert.doesNotThrow(() => {
    pattern = compileWildcardPattern(oversized, "allow" as PermissionState);
  }, "compiling an oversized pattern must not throw");
  // An oversized pattern that is just repeated 'a' should not match normal input.
  assert.equal(pattern!.regex.test("normal command"), false, "oversized pattern must not match normal input");
});

runTest("REDOS-TDD: findCompiledWildcardMatch safely ignores oversized patterns in a list", () => {
  const oversized = "x".repeat(600);
  const patterns = [
    compileWildcardPattern(oversized, "allow" as PermissionState),
    compileWildcardPattern("ls *", "allow" as PermissionState),
  ];
  let match: WildcardPatternMatch<PermissionState> | null = null;
  assert.doesNotThrow(() => {
    match = findCompiledWildcardMatch(patterns, "ls -la");
  }, "matching with an oversized pattern in the list must not throw");
  assert.ok(match, "expected the normal ls * pattern to match");
  assert.equal((match as WildcardPatternMatch<PermissionState> | null)?.matchedPattern, "ls *");
});

console.log("Wildcard ReDoS TDD test suite complete.");
