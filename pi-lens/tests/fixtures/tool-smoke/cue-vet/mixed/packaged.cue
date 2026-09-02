// F8 fixture (#1522 review round 3): a directory holding BOTH a packaged
// file (this one) and a package-less file (loose.cue). `cue vet .` builds
// only this package and exits 0 WITHOUT ever evaluating loose.cue — the
// silent-exclude shape F8 is about.
package smoke

a: int
