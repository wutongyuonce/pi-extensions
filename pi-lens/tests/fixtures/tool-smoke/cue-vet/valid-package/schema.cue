package smoke

// F1 fixture (#1522 review round 1): a valid two-file split-schema/values
// package — the normative CUE authoring style. `#Service` is defined here
// and used from values.cue. Vetting values.cue ALONE (the pre-fix behavior)
// reports `reference "#Service" not found` because it never loads this
// sibling; vetting the whole package (the fix) is clean. See cue-vet.test.ts
// for the parser-level regression proof.
#Service: {
	name: string
	port: int
}
