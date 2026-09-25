# jscpd fixtures

`jscpd-5.3.0-report.json` is a genuine `jscpd` 5.3.0 CLI report, not a
hand-written subset (#3434 review finding F3434-1: the previous fixture had
been reduced by hand and omitted `detectionDate`, `formats`, `end`,
`endLoc`/`startLoc`, `format`, `fragment`, `isNew` and `kind`).

## Regeneration

Captured 2026-09-25 against the real `jscpd@5.3.0` npm package (a Rust
wrapper binary), installed in isolation:

```sh
mkdir /tmp/jscpd-capture && cd /tmp/jscpd-capture
npm init -y
npm install jscpd@5.3.0 --no-save
```

Scratch project with two files sharing an 80-line duplicate block plus one
clean file (mirrors `tests/clients/jscpd-report-compatibility.test.ts`'s
shape, generated with a small script — see git history for the exact
generator):

```
scratch-project/
  index.ts    # "// index.ts\n" + 80 lines of helperFnN(x) { ... }
  second.ts   # "// second.ts\n// leading unique line\n" + the same 80 lines
  clean.ts    # a short unrelated file, no duplicate
```

Run with the same argv shape `clients/jscpd-client.ts`'s `runScan` builds
(positional `.`, then flags, `--reporters json --output <dir>`):

```sh
./node_modules/.bin/jscpd . \
  --min-lines 5 --min-tokens 50 \
  --reporters json --output /tmp/jscpd-capture/out \
  --ignore "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/*.md,**/*.txt,**/*.json,**/*.yaml,**/*.yml,**/*.toml,**/*.lock,**/*.test.*,**/*.spec.*,**/*.poc.test.*,**/__tests__/**,**/tests/**"
```

`./node_modules/.bin/jscpd --version` printed `jscpd 5.3.0`.

The emitted `/tmp/jscpd-capture/out/jscpd-report.json` was copied verbatim
into this fixture and re-serialized with `JSON.stringify(data, null, "\t")`
for the repo's tab-indent convention — no field was added, removed or
renamed, and no value was edited. It contains no absolute paths (jscpd
reports names relative to the scan root), so no path substitution was
needed. `detectionDate` is the real capture timestamp; it is read by
nothing in `parseReport()` and is left as emitted.
