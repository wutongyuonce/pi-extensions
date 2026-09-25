// #239 Phase 2 baseline fixture: NO sgconfig here — the ast-grep LSP must still
// attach (via `lsp --config <shipped baseline>`) and flag a shipped rule.
// `arr.sort()` with no comparator trips the bundled `no-sort-without-comparator`.
const items = [3, 1, 2];
const sorted = items.sort();

export { sorted };
