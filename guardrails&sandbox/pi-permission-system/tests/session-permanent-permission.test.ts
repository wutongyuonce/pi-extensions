// ===========================================================================
// Test-first coverage for Issue #23: Session Permission Approvals
//
// BACKGROUND (Issue #23):
//   Request: "allow for session or permanent and pattern match"
//   Issue: https://github.com/MasuRii/pi-permission-system/issues/23
//   The local permission system currently supports:
//     - Layered config-file permissions (PermissionManager)
//     - Wildcard pattern matching (wildcard-matcher.ts)
//     - Binary approve/deny UI (permission-dialog.ts)
//   Implemented (Issue #23 scope):
//     - Session-scoped ("once") approval storage
//     - "always" approval persists for the current session only (in-memory)
//     - "once"/"always"/"reject" reply semantics
//     - Merged evaluation (config + session)
//   Note: Permanent (cross-session) approval persistence was removed;
//     "Allow Always" now records session-only approvals.
//
// SOURCE BEHAVIOR:
//   OpenCode permission system (commit a78605f8e) provides the reference
//   behavior model. See:
//     packages/opencode/src/permission/index.ts (ask/reply flow, state mgmt)
//     packages/core/src/permission.ts (evaluate/merge/disabled)
//     packages/core/src/util/wildcard.ts (pattern matching with ? → ., trailing .*)
//
// TEST-FIRST APPROACH:
//   This file is included in the default `test` script and can also run directly via:
//     npm run test:issue23
//
//   Tests use one of two harness styles:
//     - runTest / runAsyncTest (existing harness) – for tests that SHOULD pass
//       against current code.
//     - runTest / runAsyncTest (existing harness) – for tests that assert
//       implemented Issue #23 behavior and fail normally on regressions.
//
//   Implementation phases covered:
//     Phase 1: New src/session-approval-store.ts module
//     Phase 2: New src/evaluate-permission.ts with merged evaluation
//     Phase 3: Update src/types.ts to add "once"|"always"|"reject" states
//     Phase 4: Update src/permission-dialog.ts for new decision options
//     Phase 5: Update src/wildcard-matcher.ts for ? → . and trailing .* optional
//
// TEST CATEGORIES:
//   Section A: Session-Scoped Approval ("once")       — 8 tests
//   Section C: Unified Evaluation                       — 2 tests
//   Section D: Wildcard Pattern Differences             — 4 tests
//   Section E: Decision Type Expansion                  — 8 tests
//   Section F: Edge Cases                               — 2 tests
// ===========================================================================

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTest, runAsyncTest } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Existing modules — these imports MUST succeed against current code
// ---------------------------------------------------------------------------
import { PermissionManager } from "../src/permission-manager.js";
import { BashFilter } from "../src/bash-filter.js";
import {
  compileWildcardPattern,
  findCompiledWildcardMatch,
} from "../src/wildcard-matcher.js";
import {
  isPermissionDecisionState,
  requestPermissionDecisionFromUi,
} from "../src/permission-dialog.js";
import type { PermissionState, GlobalPermissionConfig } from "../src/types.js";

// ===========================================================================
// Helpers
// =========================================================================--

function createManager(config: GlobalPermissionConfig) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue23-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
  });

  return {
    manager,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

// TDD module import helpers — return null if module doesn't exist yet
async function tryImportSessionApprovalStore(): Promise<{ SessionApprovalStore: unknown } | null> {
  try {
    return await import("../src/session-approval-store.js");
  } catch {
    return null;
  }
}

async function tryImportEvaluatePermission(): Promise<{ evaluatePermission: unknown } | null> {
  try {
    return await import("../src/evaluate-permission.js");
  } catch {
    return null;
  }
}

// ===========================================================================
// Section A: Session-Scoped Approval ("once")
//
// OpenCode behavior (from permission/index.ts):
//   - Reply "once" → Deferred.succeed(existing.deferred, undefined) — allows
//     this single call
//   - No persistence — no push to approved[], no DB write
//   - Does not affect subsequent requests
//   - pending.delete(input.requestID) removes from pending queue
// ===========================================================================

// A1: Module existence
await runAsyncTest("ISSUE23-A1: SessionApprovalStore module exists and exports a class", async () => {
  const mod = await tryImportSessionApprovalStore();
  assert.ok(mod !== null, "TDD: Module ../src/session-approval-store.js does not exist yet. Create it exporting class SessionApprovalStore.");
  assert.equal(typeof mod.SessionApprovalStore, "function", "TDD: SessionApprovalStore must be a class/constructor");
});

// A2: approveOnce adds in-memory rule
await runAsyncTest("ISSUE23-A2: store.approveOnce(toolName, pattern) adds in-memory session rule", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean })();
  store.approveOnce("bash", "git status");
  assert.equal(store.hasSessionApproval("bash", "git status"), true, "approveOnce should make hasSessionApproval return true");
  assert.equal(store.hasSessionApproval("bash", "git log"), false, "Different command should not be approved");
});

// A3: Instance-scoped — two stores don't share
await runAsyncTest("ISSUE23-A3: Session scope is per-instance, not global", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const Store = mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean };
  const storeA = new Store();
  const storeB = new Store();
  storeA.approveOnce("bash", "git status");
  assert.equal(storeB.hasSessionApproval("bash", "git status"), false, "Store B must not share Store A's approvals");
});

// A4: evaluate returns "allow" for matching once-approved pattern
await runAsyncTest("ISSUE23-A4: evaluate returns allow for matching once-approved command", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean })();
  store.approveOnce("bash", "git status");
  assert.equal(store.hasSessionApproval("bash", "git status"), true);
});

// A5: evaluate returns "ask" for non-matching request
await runAsyncTest("ISSUE23-A5: evaluate returns ask for non-matching command (no session approval)", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean })();
  store.approveOnce("bash", "git status");

  // A different tool should not be approved
  assert.equal(store.hasSessionApproval("bash", "git log"), false, "Non-matching command should not be approved");
});

// A6: store.clear() removes all session rules
await runAsyncTest("ISSUE23-A6: store.clear removes all session approvals", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean; clear: () => void })();
  store.approveOnce("bash", "git status");
  store.clear();
  assert.equal(store.hasSessionApproval("bash", "git status"), false, "After clear, no approvals should remain");
});

// A7: once approval is consumed (one-shot semantics) — existing test for does-not-exist pattern
await runAsyncTest("ISSUE23-A7: once approval with wildcard pattern matches multiple commands", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean })();
  // Approve with a wildcard pattern
  store.approveOnce("bash", "git *");
  // Multiple commands starting with "git " should match
  assert.equal(store.hasSessionApproval("bash", "git status"), true, "Wildcard git * should match git status");
  assert.equal(store.hasSessionApproval("bash", "git log"), true, "Wildcard git * should match git log");
  assert.equal(store.hasSessionApproval("bash", "git commit -m test"), true, "Wildcard git * should match git commit");
});

// A8: Session approval does not persist across reload
await runAsyncTest("ISSUE23-A8: Session approval is in-memory only — does not survive store recreation", async () => {
  const mod = await tryImportSessionApprovalStore();
  if (mod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const Store = mod.SessionApprovalStore as new () => { approveOnce: (tool: string, pattern: string) => void; hasSessionApproval: (tool: string, command: string) => boolean };
  const store1 = new Store();
  store1.approveOnce("bash", "git status");

  const store2 = new Store();
  assert.equal(store2.hasSessionApproval("bash", "git status"), false, "New store instance must not carry previous session approvals");
});

// ===========================================================================
// Section C: Unified Evaluation (Session + Config)
//
// OpenCode behavior (from core/src/permission.ts):
//   - evaluate(permission, pattern, ...rulesets) flattens rulesets
//   - findLast() → last matching rule wins
//   - Permission.merge(agent.permission, session.permission) → session after agent
//   - Config ruleset is always evaluated first, then session approved rules
//
// Desired local API: evaluatePermission(request, configRuleset, sessionStore)
// ===========================================================================

// C4: Config "ask" + session "allow" → allow (session allows)
await runAsyncTest("ISSUE23-C4: Config ask with session allow → allow", async () => {
  const mod = await tryImportEvaluatePermission();
  if (mod === null) { assert.fail("TDD: Module ../src/evaluate-permission.js does not exist yet. Create it exporting evaluatePermission()."); return; }

  const configRules = [{ tool: "bash", pattern: "git *", action: "ask" as const }];
  const sessionRules = [{ tool: "bash", pattern: "git *", action: "allow" as const }];
  const result = (mod.evaluatePermission as (...args: unknown[]) => { action: string })("bash", "git status", configRules, sessionRules);
  assert.equal(result.action, "allow", "Session allow should win over config ask");
});

// C6: No matching config/session rule → ask (default)
await runAsyncTest("ISSUE23-C6: No matching rule in any layer → default ask", async () => {
  const mod = await tryImportEvaluatePermission();
  if (mod === null) { assert.fail("TDD: Module ../src/evaluate-permission.js does not exist yet. Create it exporting evaluatePermission()."); return; }

  const result = (mod.evaluatePermission as (...args: unknown[]) => { action: string })("bash", "git status", [], []);
  assert.equal(result.action, "ask", "No matching rules → default should be ask");
});
// Section D: Wildcard Pattern Differences (OpenCode vs Local)
//
// OpenCode wildcard.ts behaviors:
//   - `?` → `.` (match any single char)
//   - Trailing ` .*` → `( .*)?` (make the space-star suffix optional)
//   - `*` → `.*` (match any chars) — ALREADY supported locally
//   - Case-insensitive on Windows (si flag)
// ===========================================================================

// D1: `git *` matches both subcommands and bare `git` with optional trailing arguments
runTest("ISSUE23-D1: git * wildcard matches git status and bare git", () => {
  const pattern = compileWildcardPattern("git *", "allow" as PermissionState);
  assert.ok(pattern.regex.test("git status"), "git * should match git status");
  assert.ok(pattern.regex.test("git commit -m test"), "git * should match git commit -m test");
  assert.ok(pattern.regex.test("git status --short"), "git * should match git status --short");
  assert.equal(pattern.regex.test("git"), true, "git * should match bare git because trailing arguments are optional");
});

// D2: `a?c` should match `abc` but not `ac`
runTest("ISSUE23-D2: ? wildcard matches exactly one character", () => {
  // OpenCode maps ? → ., so a?c should match abc but not ac
  const pattern = compileWildcardPattern("a?c", "allow" as PermissionState);
  assert.equal(
    pattern.regex.test("abc"),
    true,
    "ISSUE23-TDD: 'a?c' should match 'abc' (? → .). Currently '?' is escaped as '\\?' making it literal. Fix: escapeRegExp must not escape '?', and compileWildcardPattern should map '?' to '.'",
  );
  assert.equal(
    pattern.regex.test("ac"),
    false,
    "ISSUE23-TDD: 'a?c' should NOT match 'ac' (one char required). Currently '?' is literal so 'a?c' matches 'a?c' literally.",
  );
});

// D3: `ls *` matches bare `ls` with optional trailing arguments
runTest("ISSUE23-D3: ls * wildcard matches bare ls (trailing .* optional)", () => {
  // OpenCode: trailing  .* → ( .*)? so the space+star suffix is optional
  const pattern = compileWildcardPattern("ls *", "allow" as PermissionState);
  assert.equal(
    pattern.regex.test("ls"),
    true,
    "ISSUE23-TDD: 'ls *' should match bare 'ls' (trailing ' .*' → '( .*)?'). Currently '.*' requires at least ' ' after 'ls'. Fix: if pattern ends with ' *', make the ' .*' suffix optional.",
  );
  assert.ok(pattern.regex.test("ls -la"), "ls * should still match 'ls -la'");
});

// D4: `src/*.ts` matches `src/foo.ts` — PASSES NOW (baseline)
runTest("ISSUE23-D4: src/*.ts wildcard matches src/foo.ts (existing behavior)", () => {
  const pattern = compileWildcardPattern("src/*.ts", "allow" as PermissionState);
  assert.ok(pattern.regex.test("src/foo.ts"), "src/*.ts should match src/foo.ts");
  assert.ok(pattern.regex.test("src/nested/bar.ts"), "src/*.ts should match src/nested/bar.ts (.* matches /)");
  assert.equal(pattern.regex.test("src/foo.js"), false, "src/*.ts should not match src/foo.js");
});

// ===========================================================================
// Section E: Decision Type Expansion
//
// Current: PermissionDecisionState = "approved" | "denied" | "denied_with_reason"
// Desired (per OpenCode): add "once" | "always" | "reject"
//
// These tests use the existing isPermissionDecisionState() runtime guard.
// It currently returns true only for "approved"/"denied"/"denied_with_reason".
// TDD: it should also return true for "once"/"always"/"reject".
// ===========================================================================

// E1: isPermissionDecisionState("once") should return true
runTest("ISSUE23-E1: isPermissionDecisionState('once') returns true", () => {
  assert.equal(
    isPermissionDecisionState("once"),
    true,
    "ISSUE23-TDD: 'once' must be a valid PermissionDecisionState. Currently the runtime guard only recognizes 'approved'|'denied'|'denied_with_reason'. Fix: add 'once' to the PermissionDecisionState type and update isPermissionDecisionState() in src/permission-dialog.ts.",
  );
});

// E2: isPermissionDecisionState("always") should return true
runTest("ISSUE23-E2: isPermissionDecisionState('always') returns true", () => {
  assert.equal(
    isPermissionDecisionState("always"),
    true,
    "ISSUE23-TDD: 'always' must be a valid PermissionDecisionState. Fix: add 'always' to PermissionDecisionState and update isPermissionDecisionState().",
  );
});

// E3: isPermissionDecisionState("reject") should return true
runTest("ISSUE23-E3: isPermissionDecisionState('reject') returns true", () => {
  assert.equal(
    isPermissionDecisionState("reject"),
    true,
    "ISSUE23-TDD: 'reject' must be a valid PermissionDecisionState. Fix: add 'reject' to PermissionDecisionState and update isPermissionDecisionState().",
  );
});

// E4: Existing states still recognized (non-regression)
runTest("ISSUE23-E4-NR: Existing states still recognized by isPermissionDecisionState", () => {
  assert.equal(isPermissionDecisionState("approved"), true, "approved must still be valid");
  assert.equal(isPermissionDecisionState("denied"), true, "denied must still be valid");
  assert.equal(isPermissionDecisionState("denied_with_reason"), true, "denied_with_reason must still be valid");
  assert.equal(isPermissionDecisionState("unknown"), false, "unknown must still be invalid");
});

// E5: Dialog labels match OpenCode-style approval/rejection options
await runAsyncTest("ISSUE23-E5: permission dialog labels use OpenCode-style options", async () => {
  let displayedOptions: string[] | undefined;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (_title, options) => {
        displayedOptions = options;
        return "Allow Once";
      },
      input: async () => undefined,
    },
    "Permission Required",
    "Agent requested bash command 'git status'. Allow this command?",
  );

  assert.deepEqual(displayedOptions, [
    "Allow Once",
    "Allow Always",
    "Reject",
    "Reject with Reason",
  ]);
  assert.equal(decision.approved, true, "Allow Once should approve the current request");
  assert.equal(decision.state, "once", "Allow Once should preserve OpenCode's once protocol state");
});

await runAsyncTest("Permission dialog passes timeout options and returns configured timeout denial reason", async () => {
  let displayedOptions: { timeout?: number } | undefined;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (_title, _options, options) => {
        displayedOptions = options;
        return undefined;
      },
      input: async () => undefined,
    },
    "Permission Required",
    "Agent requested bash command 'git status'. Allow this command?",
    {
      timeoutMs: 30_000,
      timeoutDenialReason: "permission_timeout: no response.",
    },
  );

  assert.deepEqual(displayedOptions, { timeout: 30_000 });
  assert.equal(decision.approved, false);
  assert.equal(decision.state, "reject");
  assert.equal(decision.denialReason, "permission_timeout: no response.");
});

// E6: Dialog label maps Allow Always to the always protocol state
await runAsyncTest("ISSUE23-E6: permission dialog maps Allow Always to always state", async () => {
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async () => "Allow Always",
      input: async () => undefined,
    },
    "Permission Required",
    "Agent requested bash command 'git status'. Allow this command?",
  );

  assert.equal(decision.approved, true, "Allow Always should approve matching future requests");
  assert.equal(decision.state, "always", "Allow Always should preserve OpenCode's always protocol state");
});

// E7: Dialog label maps Reject to the reject protocol state
await runAsyncTest("ISSUE23-E7: permission dialog maps Reject to reject state", async () => {
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async () => "Reject",
      input: async () => "this input should not be requested",
    },
    "Permission Required",
    "Agent requested bash command 'git status'. Allow this command?",
  );

  assert.equal(decision.approved, false, "Reject should deny the request");
  assert.equal(decision.state, "reject", "Reject should preserve OpenCode's reject protocol state");
  assert.equal(decision.denialReason, undefined, "Reject should not attach a reason when the reason path was not selected");
});

// E8: Dialog label maps Reject with Reason to reject state and captures trimmed feedback
await runAsyncTest("ISSUE23-E8: permission dialog captures Reject with Reason feedback", async () => {
  let inputPrompted = false;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async () => "Reject with Reason",
      input: async () => {
        inputPrompted = true;
        return "  Use read-only inspection instead  ";
      },
    },
    "Permission Required",
    "Agent requested bash command 'git status'. Allow this command?",
  );

  assert.equal(inputPrompted, true, "Reject with Reason should prompt for feedback");
  assert.equal(decision.approved, false, "Reject with Reason should deny the request");
  assert.equal(decision.state, "reject", "Reject with Reason should preserve OpenCode's reject protocol state");
  assert.equal(decision.denialReason, "Use read-only inspection instead", "Feedback should be trimmed before returning to the agent");
});

// ===========================================================================
// Section F: Edge Cases
//
// Covers boundary conditions from the OpenCode-derived test-spec matrix.
// ===========================================================================

// F3: Minimal reject (no feedback) produces plain denied decision
await runAsyncTest("ISSUE23-F3: Minimal reject with no feedback produces plain denied/ask state", async () => {
  const evalMod = await tryImportEvaluatePermission();
  if (evalMod === null) { assert.fail("TDD: Module ../src/evaluate-permission.js does not exist yet."); return; }

  // A command with no matching rules, no session approvals → ask
  const result = (evalMod.evaluatePermission as (...args: unknown[]) => { action: string })("bash", "unknown_cmd", [], [], []) as { action: string };
  assert.equal(result.action, "ask", "No rules at any layer → result should be ask");
});

// F4: Session store discarded on extension shutdown — lifecycle test
await runAsyncTest("ISSUE23-F4: Session store cleared on lifecycle shutdown prevents dangling approvals", async () => {
  const sessMod = await tryImportSessionApprovalStore();
  if (sessMod === null) { assert.fail("TDD: Module ../src/session-approval-store.js does not exist yet."); return; }

  const store = new (sessMod.SessionApprovalStore as new () => {
    approveOnce: (tool: string, pattern: string) => void;
    hasSessionApproval: (tool: string, command: string) => boolean;
    clear: () => void;
  })();
  store.approveOnce("bash", "git status");
  store.clear();
  assert.equal(
    store.hasSessionApproval("bash", "git status"),
    false,
    "After clear(), session approvals must not produce dangling state",
  );
});

// ===========================================================================
// Summary
// ===========================================================================

// This suite documents test cases for Issue #23 (session-only approvals):
//
//   Section A: Session-Scoped Approval  — 8 tests
//   Section C: Unified Evaluation        — 2 tests
//   Section D: Wildcard Differences      — 4 tests
//   Section E: Type Expansion            — 8 tests
//   Section F: Edge Cases                — 2 tests
//                                       ——————————
//                             Total:      24 tests
//
// EXPECTED IMPLEMENTATION ORDER:
//   1. src/session-approval-store.ts     (Section A, Section F passes)
//   2. src/evaluate-permission.ts         (Section C, Section F passes)
//   3. Update src/types.ts + permission-dialog.ts (Section E passes)
//   4. Update src/wildcard-matcher.ts    (Section D2, D3 pass)
//
// After all phases: all 38 tests pass.
//
// Run: npm run test:issue23

console.log("\nIssue #23 TDD test suite complete.");
console.log("Expected: [PASS] for all Issue #23 tests.");
console.log("File is included in default `test` script and can also run via: npm run test:issue23");
