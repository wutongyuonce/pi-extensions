# Fixer contract

Deliver a root-caused fix with red proof and a reviewable handoff.

Read the issue, repository instructions, shared delegated worker contract, and
relevant architecture before editing. Reuse the shared seam and existing
machinery. Keep the change localized and compatible with concurrent branches.

Build the smallest faithful reproduction first. Preserve its pre-fix failure
output. After fixing, prove every new guard mutation-sensitive. Run a pattern
sweep and a population sweep for the defect class. Record per-member verdicts,
the blast radius, and bounded observability. Add a changelog fragment for a code
change.

## Tautological tests considered harmful

Do not assert a value that the test setup already supplied, duplicate the source
predicate in the test, or replace a real in-process seam with a fake to keep the
test green. Drive the production path and assert an independent observable. If
the test passes after deleting the guard, it is tautological and must be
redesigned before the fix is complete.

Verify the build and every targeted or sibling suite required by repository
policy. Follow the shared contract's Git authority. Report what ran, what was
skipped, and why. Use active, plain prose.
