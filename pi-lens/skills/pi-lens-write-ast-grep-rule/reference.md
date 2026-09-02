# pi-lens ast-grep Rule Reference

Deep-dive companion to `SKILL.md`. Read this when you're debugging a rule
that isn't matching (or over-matching) the way you expect: ReDoS-safe regex
authoring, string-escape quirks in node text, `has`/`inside` `stopBy`
defaults and when to override them, boolean-parameter matching across two
grammars, and precision-over-recall heuristics for denylist-shaped rules.

## Hard-won gotchas (NAPI runner specifics — verified)

```
⚠ `has`/`inside` default to DIRECT child/parent — add `stopBy: end` for a recursive search.
   This cuts BOTH ways, so think about where the target node actually lives:
   - Target is a grandchild+ → you MUST add `stopBy: end` or the `has` never matches.
     `switch-without-default` = `switch_statement` not has `switch_default`: the default
     lives under `switch_body`, so without `stopBy: end` it matches nothing and every
     switch (even ones WITH a default) is flagged. Same for `nested-ternary` catching a
     parenthesized `a ? (b ? c : d) : e`.
   - Target is the direct child → leave it at `neighbor` (default). Adding `stopBy: end`
     OVER-reports: `throw_statement` has `string` + `stopBy: end` flags `throw new
     Error("x")` (the string is nested), and `expression_statement` has `new_expression`
     + `stopBy: end` flags `fn(new Error())` as a discarded error. Keep these direct.
   napi's `has` never matches the node itself, so a self-referential `kind: X` has
   `kind: X` (with `stopBy: end`) correctly flags only genuinely-nested X.

✅ Prefer `regex` on the matched node's OWN text over `has` when you only need to
   inspect the node — avoids recursive-descendant false positives:
     kind: export_statement
     regex: '^export\s+(let|var)\b'      # precise; no has-recursion FP
   (NAPI evaluates `regex` with JS RegExp on node.text() — keep it LINEAR so the
   detector can't itself ReDoS.)

⚠ String-literal regexes match SOURCE text, not the runtime string value.
   Inspect the exact node text before writing constraints:
     ast-grep run --kind string --lang ts sample.ts --json=compact
   Example: source `"\\|"` is node text `"\\\\|"` in JSON; to match a
   source-level escaped backslash (`\\`) followed by a non-backslash, the rule
   regex needs FOUR regex backslashes, preferably in a YAML block scalar:
     regex: >-
       ^["'`]\\\\[^\\A-Za-z0-9$]
   This is how `incomplete-string-escaping` catches both `"\\|"` and
   `'\\"'`. Avoid shell here-doc probes for this class — shell/JSON escaping
   can silently eat a backslash and make the rule look broken.

⚠ `-js` twins: remember there are TWO execution surfaces.
   <!-- verified: clients/dispatch/runners/ast-grep-napi.ts:205-216,450-455, c170d94b -->
   - ast-grep CLI/LSP language-gates by `language:`. A `language: TypeScript`
     rule is not enough for standalone `.js` coverage, so shipped user-facing
     TS/JS rules that should fire under the ast-grep LSP usually need a `-js`
     twin with `language: JavaScript` plus its own fixture.
   - the in-process NAPI fallback (`ast-grep-napi.ts` — pi-lens source checkout
     only, not present in the installed package) already DEDUPES by grammar
     (#657): `ruleLanguageForFile` (`ast-grep-napi.ts:205-216`) maps each file
     extension to its actual grammar, and the matcher (`:450-455`) skips any
     `language:`-tagged rule whose tag doesn't match that grammar. A TS rule
     and its JS twin no longer double-fire on the same file in fallback mode.
   - **`-js` twins are needed only when the rule body itself is
     grammar-divergent** (different node kinds/fields between the TS and JS
     grammars). A grammar-agnostic body doesn't need a twin for fallback
     coverage — the dedup above already scopes it correctly; ship a twin only
     when standalone `.js` coverage through the ast-grep CLI/LSP baseline is
     required (see the first bullet).
   - **Grammar-divergent bodies** still need separate variants regardless:
     e.g. `no-flag-argument` uses `required_parameter` in TS and
     `assignment_pattern` in JS.

✅ Node-kind facts (tree-sitter-typescript grammar — NOT the TS compiler / Roslyn):
   - let / const  → `lexical_declaration`     (var is NOT here)
   - var          → `variable_declaration`
   - a regex literal's pattern text  → `regex_pattern`
   - x[i] index access  → `subscript_expression`   (NOT element_access_expression)
   - obj.prop access    → `member_expression`      (NOT property_access_expression)
   - !x / -x / typeof x → `unary_expression`
   - a ? b : c          → `ternary_expression`

❌ Wrong-grammar kind names = silent dead rule. `element_access_expression`,
   `property_access_expression`, `binary_operator`, etc. are TS-compiler/Roslyn names, not
   tree-sitter's. napi REJECTS the whole rule ("invalid kind matcher") so it never runs.
   Verify a kind exists before shipping:
     node -e 'import("@ast-grep/napi").then(s=>{const r=s.ts.parse("x[i]").root();
       const f=(n,k)=>{let c=n.kind()===k?1:0;for(const x of n.children())c+=f(x,k);return c};
       console.log(f(r,"subscript_expression"))})'   # >0 means the kind is real

✅ Test through the REAL runner from the pi-lens source checkout's repo root — it loads the actual shipped
   rules from rules/ast-grep-rules/rules. Assert on diagnostic `rule` ids:
     const res = await runner.run(ctx);  // ctx.filePath = temp .ts, cwd = repo  (pi-lens source checkout only — not present in the installed package)
   For pattern/kind/regex-only rules (CLI-identical semantics) `ast-grep scan` is fine.

✅ Before shipping any text/regex detector, FP-scan the codebase:
     ast-grep scan -r <rule>.yml clients tools
   Real safe variants bite (e.g. ReDoS: (ba+)+ is safe — a mandatory prefix makes
   the partition unique; flag only a single quantified atom inside the group).
```

## Scoping to the nearest enclosing X (#1794 F1)

`stopBy` controls how far the ancestor/descendant walk searches. It is not a
stop CONDITION. An `any:` kind list inside `inside`/`has` decides which
nodes the walk is ALLOWED to match — it does not tell the walk where to
halt. `stopBy: end` alone searches every ancestor up to the file root, so a
guard several scopes out can suppress a finding inside an unrelated closure.

To scope a relation to the nearest enclosing function (or any other
boundary), give `stopBy` its OWN rule — the same kind list used as the
match target — so the walk stops at the first satisfying ancestor and can
never escalate past it:

```yaml
inside:
  stopBy:                       # the BOUNDARY: halts the walk here
    any:
      - kind: function_declaration
      - kind: method_definition
      - kind: arrow_function
      - kind: function_expression
  any:                          # the MATCH TARGET: same list, different job
    - kind: function_declaration
    - kind: method_definition
    - kind: arrow_function
    - kind: function_expression
  has:
    stopBy: end
    pattern: $M.has($K)
```

This is the fix for #1794 F1: an earlier `no-non-null-assertion` exclusion
used `stopBy: end` with only the `any:` kind list as the match target, so a
`.has()`/`.length` guard in an OUTER function suppressed a closure's `!`
several scopes in. The same defect shape — `stopBy: end` mistaken for a
boundary — shipped twice in the same 2026-08-20 window: once here, and once
in `redundant-unsafe-function`'s `# Safety` valve (an unbounded backward
comment scan, fixed in `00284bcc`). See
`rules/ast-grep-rules/rules/no-non-null-assertion.yml` for the full working
rule.

## Matching things a pattern can't express (#305)

```
❌ A parameter default is NOT a `$X = false` pattern. `pattern: $FLAG = false` parses as
   an `assignment_expression` (statement context) and never matches a function parameter.
   Match the PARAM NODE + its child literal instead, capturing the name for reuse:
     # TS grammar
     - kind: required_parameter
       all:
         - has: { field: pattern, pattern: $FLAG }
         - has: { any: [ { kind: "true" }, { kind: "false" } ] }
     # JS grammar (assignment_pattern, with fields left/right)
     - kind: assignment_pattern
       all:
         - has: { field: left, pattern: $FLAG }
         - has: { field: right, any: [ { kind: "true" }, { kind: "false" } ] }

✅ Metavar consistency works ACROSS sibling clauses of an `all` — a metavar bound in one
   `has` must match the SAME text everywhere it reappears. Use it to CORRELATE nodes, which
   is what makes a structural rule precise:
     all:
       - has: { stopBy: end, kind: required_parameter, has: { field: pattern, pattern: $FLAG } }
       - has: { stopBy: end, any: [ { pattern: "if ($FLAG) $$$" }, { pattern: "if (!$FLAG) $$$" } ] }
   This fires ONLY when the function branches on the SAME param it declared boolean — a
   boolean default that's never branched on, or a branch on a different var, won't match.

❌ Two `has:` keys in one mapping silently OVERWRITE (YAML: last key wins). For multiple
   descendant constraints use `all:` with a LIST of `has` entries, never repeated `has:`.

✅ Prefer a high-precision structural guard over an unbounded denylist. Message-chain
   (Demeter) floods on fluent/promise/builder chains; rather than denylist every fluent
   method name, REQUIRE the chain's first calls to be accessors (`get*`/`is*`/`has*`) via
   `constraints` regex — promise/fluent/builder methods aren't accessor-named, so they're
   excluded by construction. Precision over recall.
```
