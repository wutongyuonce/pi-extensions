// F10 fixture (#1522 review round 4): a clean two-file package where
// values.cue opens with a file-level attribute BEFORE its package clause —
// legal CUE (`@extern(embed)` is the documented real case; `@mytag(foo)`
// here avoids needing an actual embed/module setup). Pre-fix, this made
// values.cue misread as package-less and routed to single-file vet, which
// false-positives its reference into this file as "reference not found" on
// an otherwise clean package.
package smoke

#Service: {
	name: string
}
