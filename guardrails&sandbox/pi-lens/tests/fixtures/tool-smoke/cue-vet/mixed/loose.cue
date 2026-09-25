// F8 fixture sibling — see packaged.cue. This file is package-less and
// carries a genuine conflicting value; `cue vet .` on this directory never
// evaluates it (silent exit 0), so the runner must go straight to
// single-file scope for it instead of trusting the directory's clean exit.
b: int & "x"
