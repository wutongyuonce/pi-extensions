---
name: pi-lens-write-ast-grep-rule
description: Use when writing a new pi-lens ast-grep rule YAML file — covers schema, drop path, gotchas, and NAPI runner constraints
---

# Writing a pi-lens ast-grep Rule

Drop path: `rules/ast-grep-rules/rules/<id>.yml`  
Same `id` as a built-in overrides it. Multiple rules per file: separate with `---`.

## Minimal template

```yaml
id: no-foo-bar
language: TypeScript        # PascalCase — see languages below
severity: warning           # error | warning | hint | info — pick by evidence, see below
message: "Avoid foo.bar() — use baz() instead"
note: |
  Longer explanation / fix guidance here.
rule:
  pattern: foo.bar($ARG)
```

**Pick the severity by the evidence behind the rule, not by feel:**

- **`error`** — only with a documented zero-false-positive audit in the `note`.
  Only `error` maps to semantic `blocking` and stops a turn.
- **`warning`** — a real finding with a known, bounded false-positive rate.
- **`hint` / `info`** — style opinions. They render as advisory text, never
  block, and lose the report budget to warnings when a report is capped.

Full policy and the `error`-promotion procedure: AGENTS.md's "Severity policy
(#1777)" section. Read it before shipping anything above `warning`.

## Before promoting to error

Three things must all be true, and the rule's `note` must record them:

1. **A multi-corpus false-positive census**, not a single-tree count. Run the
   rule over pi-lens's `clients/`/`tests/` plus at least one real external
   codebase of the kind the rule targets, classify every hit, and put the
   table in the note.
2. **Structural narrowing before exemption.** Suppress a legitimate idiom
   with a relational constraint (`inside`/`has`/`follows`, scoped path
   globs), not with prose telling readers to ignore the hit. Narrow first —
   don't reach for a lower tier as the easy way out. `no-non-null-assertion`
   was demoted to `hint` (`0124608a`), then reverted back to `warning` once
   the same false positives were closed with a structural exclusion instead
   (`b3e1fd79`).
3. **Self-scan wiring.** Tag the rule `metadata.category: pi-lens-self-scan`
   so `npm run astgrep:self-scan` holds this tree at zero in CI. An `error`
   rule that never runs against pi-lens's own source is an unaudited claim.

If the post-narrowing residual is still tens of legitimate hits, stop and
report the numbers instead of shipping at `error`.

## Language values

`TypeScript` `JavaScript` `Python` `Go` `Rust` `Java` `C` `Cpp` `CSharp` `Kotlin` `Ruby` `Php`

## Rule conditions

```yaml
rule:
  pattern: foo($X)          # ast-grep pattern — $X single, $$$ARGS multi
  kind: call_expression     # AST node kind (alternative to pattern)
  regex: "secret|token"     # regex on node text
  has:                      # descendant must match
    pattern: await $$$
  not:
    kind: comment
  any:
    - pattern: foo($X)
    - pattern: bar($X)
  all:
    - pattern: $OBJ.send($$$)
    - not: { kind: await_expression }
```

## Relational & constraint conditions — all supported (native napi, #206)

The runner matches every rule through napi's native engine (`root.findAll({rule,
constraints})`), fed by a faithful `js-yaml` parse. The **full ast-grep grammar works** —
nest freely; nothing is silently skipped:

```yaml
rule:
  kind: call_expression
  inside:                     # ancestor must match
    kind: function_declaration
    stopBy: end               # ↑ search ALL ancestors (default is direct parent)
  has:                        # descendant must match (default: DIRECT child)
    field: arguments          # field constraints work
  follows:                    # immediately-preceding sibling
    pattern: const $X = $V
constraints:                  # metavariable regex constraints work
  X:
    regex: "Error$"
```

⚠ **`has`/`inside` default to the immediate child/parent (`stopBy: neighbor`).** For a
recursive descendant/ancestor search add `stopBy: end`. This is the #1 migration
gotcha — see the `has` note in `reference.md`.

⚠ **`stopBy: end` alone is not a boundary.** It's a search-depth control — how far
the walk searches — not a stop condition; the `any:` kind list only decides what
CAN satisfy the match, not where the walk halts. To scope a relation to the
nearest enclosing function (or any other boundary), give `stopBy` its own rule.
See "Scoping to the nearest enclosing X" in `reference.md` (#1794 F1 — this bug
shipped twice in one window).

## YAML quoting — REQUIRED (js-yaml will reject the rule otherwise)

The parser is a real YAML parser, so unquoted special chars throw and the rule is
**silently dropped**:

```
❌ message: !!value to coerce boolean    # `!!` is a YAML tag → js-yaml THROWS, rule dropped
✅ message: "!!value to coerce boolean"
❌ message: foo: bar baz                  # bare `:` → parsed as a nested mapping
✅ message: "foo: bar baz"
   Quote any scalar starting with  ! & * ? | > % @ `  or containing  : #
   Quote keyword-like kinds:  kind: "true"   (bare `true` becomes a boolean → invalid kind)
```

## Gotchas

```
❌ Overly broad patterns — filtered out automatically
   $VAR  $NAME  $_  $X  $EXPR  (single bare metavar)

❌ PascalCase language is required
   language: typescript  →  language: TypeScript

❌ $VAR inside strings — matches literal "$VAR", not a metavar
   "from $PATH"  →  use tree-sitter or grep instead

✅ Test in playground: https://ast-grep.github.io/playground.html
✅ Schema + autocomplete: rules/ast-grep-rules/rule-schema.json
✅ Docs: docs/custom-rules.md
```

## Reference doc — read before writing a NAPI-runner-specific or hard-to-express rule

`reference.md` (same directory) covers: ReDoS-safe regex authoring, node-text
string-escape quirks, `has`/`inside` `stopBy` defaults (and when to override
them), scoping a relation to the nearest enclosing node with a `stopBy`
boundary rule, the `-js` twin dedup behavior (#657), boolean-parameter
matching across the TS/JS grammars, and precision-over-recall heuristics for
denylist-shaped rules. Read it when a rule isn't matching (or over-matching)
the way you expect, or before shipping a `regex`/`has`-heavy rule.

## Testing a suppression

Every relational suppression (a `has`/`inside`/`not` exclusion for a
legitimate idiom) needs two fixtures per bound metavariable, not one:

1. **A same-binding valid case** — the idiom the exclusion is meant to
   suppress, with the metavariable bound consistently (same receiver, same
   key).
2. **A mutation-guard invalid case** — the same shape with the binding
   broken: a different key, a different receiver, or a boundary-crossing
   lookalike (the guard lives in the wrong scope). This proves the
   exclusion checks the BINDING, not just the pattern's presence somewhere
   in the file.

`rules/ast-grep-rules/rule-tests/no-non-null-assertion-test.yml` is the model: alongside the
get-after-has/pop-after-length valid cases, it fixtures a different-key
guard, a different-map guard, and an outer-function guard that must NOT
suppress an inner closure — each one red if the corresponding binding check
is deleted.

Corpus silence is not evidence. A valve with zero corpus hits needs
adversarial fixtures MORE, not less — `redundant-unsafe-function` targets
Rust, so it has no pi-lens corpus to census against, and its `# Safety`
valve still shipped an unbounded backward scan that over-suppressed real
detections, caught only by adversarial fixtures in review (`00284bcc`). A
documented blind spot (an idiom the rule knowingly can't distinguish from a
bug) becomes an `invalid`-direction fixture with a comment naming the gap,
never silence.

Regenerate the catalog doc with `npm run docs:rule-catalogs` after adding or
changing a rule — never hand-edit the generated catalog.

## Validating a candidate rule against the REAL engine (not the warm MCP cache)

Live-binary discipline (AGENTS.md shape 16) applies here too: verify parsing
and match behavior against a real `ast-grep` run before you write it into a
rule note or a test fixture — a hand-written fixture pins a guess, not a fact.

```

# inspect how a PATTERN parses → find the node kind you actually need

ast-grep run -p 'x = false' --lang ts --debug-query=cst file.ts

# match by kind (──kind and ──pattern are mutually exclusive in `run`)

ast-grep run --kind required_parameter --lang ts file.ts

# run ONE rule from an sgconfig against a sample

ast-grep scan -c <sgconfig.yml> --filter '^<id>$' sample.ts

# run the fixture harness for one rule

ast-grep test -c rules/ast-grep-rules/.sgconfig.yml --skip-snapshot-tests --filter '<id>'

```
