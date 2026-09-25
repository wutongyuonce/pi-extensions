package smoke

// Tool-smoke fixture for the `cue-vet` auxiliary runner (#1522).
//
// This is deliberately an EVALUATION error (a conflicting concrete value),
// the exact class cuelsp does NOT publish (it reports load/parse errors only
// — see docs/language-coverage.md's CUE row). `cue vet` catches it:
//
//   $ cue vet ./bad.cue
//   a: conflicting values int and "hello" (mismatched types int and string):
//       .\bad.cue:<line>:4
//       .\bad.cue:<line>:10
//
// Verified against cue v0.17.1. The runner uses `-c=false` (allow incomplete
// values) so an ordinary schema-only file — no concrete data at all — does
// not fail vet's default "some instances are incomplete" gate; that flag
// does not suppress this real type conflict.
a: int & "hello"
