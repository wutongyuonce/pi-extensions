// F5 fixture (#1522 review round 2): same package-less shape as clean.cue,
// but with a real evaluation error, to prove the single-file fallback still
// reports a genuine defect and doesn't just go permanently quiet.
a: int & "hello"
