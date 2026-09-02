// F5 fixture (#1522 review round 2): a package-less standalone CUE file —
// no `package` clause, no cue.mod — the common single-file config style.
// `cue vet -c=false .` on this directory fails with "build constraints
// exclude all CUE files in .: <file>: no package name" and NO :line:col,
// which used to read as an unattributable whole-vet failure and block
// every edit to this otherwise-clean file. The fix falls back to
// `cue vet -c=false <file>` for exactly this shape, which vets clean.
a: {
	b: int
}
