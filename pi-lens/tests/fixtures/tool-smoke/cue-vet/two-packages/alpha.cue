// F6 fixture (#1522 review round 2): two DIFFERENT package names sharing
// one directory — legal CUE, each file is its own independent unit.
// `cue vet -c=false .` fails with `found packages "alpha" (alpha.cue) and
// "beta" (beta.cue) in "."`, again with no :line:col, blocking every edit
// to both files before the fix. Both are individually clean.
package alpha

a: int
