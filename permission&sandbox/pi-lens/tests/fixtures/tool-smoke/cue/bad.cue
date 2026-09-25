package smoke

// Tool-smoke fixture for the CUE LSP — an unclosed struct.
//
// `package smoke` MUST stay on line 1. cuelsp only publishes the parse
// diagnostic when the package clause is the very first line; a comment header
// above it suppresses the diagnostic entirely, which is how this fixture
// passed vacuously twice. Comments go BELOW the package clause.
//
// The defect must also be a SYNTAX error, not an evaluation error: cuelsp
// reports load and parse errors as you type, and leaves conflicting values and
// failed constraints to `cue vet`.
//
// Real `cue lsp serve` v0.17.1 publishes: "expected '}', found 'EOF'".
a: {
