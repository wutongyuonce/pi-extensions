# Scanner cache records as pi-lens 4.2.1 wrote them

Durable `CacheManager` scanner records (`.pi-lens/cache/<scanner>.json`) in the
shape 4.2.1 persisted. `#1892` changed how `clients/runtime-turn.ts` READS these
three stores (one shared freshness pass instead of three); the records
themselves did not change, and a 4.2.1 cache left on disk across an upgrade must
still parse and render. `tests/clients/runtime-turn-scanner-freshness-fold.test.ts`
drives the real `CacheManager.readCache` + real `handleTurnEnd` over them.

`__PROJECT_ROOT__` stands in for the absolute project root a real record carries
— the only field that cannot be committed verbatim. The test substitutes its
temp root, writes the sibling `.meta.json` (the TTL stamp is wall-clock, so a
committed one would always read stale) and reads them back through the real
reader.

`manifest.json` is the checked-in 4.2.1 producer-field manifest. It records the
fields each named client could persist at that version; in particular,
`analyzedFiles` is intentionally absent because none of the three v4.2.1 client
sources wrote it.
