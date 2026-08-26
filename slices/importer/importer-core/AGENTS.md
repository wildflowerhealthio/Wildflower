# AGENTS.md — slices/importer/importer-core

The pure core of the importer slice. No DOM, no `fs`, no React — HAR text in,
an `ImportPreview.ImportPreview` out, and an opt-in `ImportPreview.persist`
that writes it.

## Layering

A `-core` package following the rule in [slices/AGENTS.md](../../AGENTS.md):
adapters depend on it, it depends on no adapter. Its accepted imports are exactly
four: `web-trace-core` (the HAR codec and `withMetaSource`),
`importer-fundamentals` (the extraction runner, the recognizer, and the
`Importer` shape), `fhir-r4-importer` (the assembled `fhirR4Importer`), and
`fhir-r4` (resources and the persist sink). It re-derives none of them.

Auto-picked-up by the root `slices/**/vite.config.ts` Vitest glob — no root
config edit. Node/neutral test env (not jsdom); the package touches no DOM.

## Module layout

The public surface is two `effect`-style namespaces plus the closed list, all
re-exported from `src/index.ts`:

- **`src/import-preview.ts`** — the **`ImportPreview`** namespace: the result
  union `ImportPreview.ImportPreview` — `NoImporterClaims` (no registered
  importer understood the archive — a first-class outcome, not an error) or
  `Preview` (one did; here is what it would write, grouped by `resourceType`
  with `importerTag` naming the claimant and every non-resource outcome
  counted) — plus `ImportPreview.persist`, re-exported from the write module
  below.
- **`src/importers.ts`** — the **closed, compile-time** `importers` list. Each
  entry is an `Importer.Importer<FhirResource>` value assembled in its own
  importer project (`fhir-r4-importer`'s `fhirR4Importer`); registering one is
  a single static append here. Only `fhir-r4` is registered.
- **`src/har-import.ts`** — the **`HarImport`** namespace, the read half.
  `HarImport.run(harText)` decodes the archive (`fromHarJson`), maps its
  `ArchivedExchange`es to the structural `Extraction.Input`s the runner reads
  (`toInput`), resolves the claiming importer (`Recognizer.resolve`), runs its
  entities (`Extraction.run`), and folds the extraction into a `Preview`.
- **`src/persist-preview.ts`** — the write half, surfaced as
  `ImportPreview.persist(preview, sourceRef)`: flatten the previewed
  resources, stamp each with `meta.source = sourceRef` via `web-trace-core`'s
  `withMetaSource`, and write them through `fhir-r4`'s `persistResources`.
- **`src/fixtures/chrome-fhir-capture.har.json`** — a committed Chrome DevTools
  export carrying FHIR traffic amid browser noise, the foreign-archive half of
  the preview tests.

## The pipeline

`HarImport.run` is detect → extract → fold:

1. **Decode.** `fromHarJson(harText)` → an `ArchivedSession`, or a `ParseError`
   (the only failure the whole read half has).
2. **Map.** Each `ArchivedExchange` becomes an `Extraction.Input`. The two
   line up field-for-field; `toInput` restates the eight fields
   explicitly so a drift in either shape is a compile error at the one seam the
   two packages meet.
3. **Detect.** `Recognizer.resolve(importers, responses)` picks the
   most specific claiming importer. None → `NoImporterClaims`.
4. **Extract.** The claimed importer's `entitiesFor({ harText })` entities
   fold through `Extraction.run` → the four-way `Extraction.Extraction`.
5. **Fold.** Batches group by `resourceType`; `unmatched`, `parseFailures`, and
   `bodyAbsent` become counts (and, for parse failures, `{ url, error }` data).
   `importer.rootOf` folded over every response URL yields `rootUrls` — the
   distinct set of source roots the archive reached, no single one chosen.

`ImportPreview.persist` is the opt-in tail: flatten → stamp `meta.source` →
write.

## Traps

- **The read half must never require the write client.** `HarImport.run`'s
  Effect is `Effect<ImportPreview, ParseError>` with `R = never`. If it ever
  reached `FhirR4ResourcesHttpApiClient`, `R` would widen and the preview stops
  being a pure function of the archive. A test asserts this at the type level
  (annotating `R` as `never`) and at runtime (running with no layers provided).
  Keep it that way — the preview-then-confirm safety rests on it.
- **`NoImporterClaims` is data, not an error.** A browser's HAR export of a
  site we have no importer for, or one carrying no FHIR resource URL, is an
  ordinary outcome a caller renders. Only a malformed archive reaches the error
  channel.
- **Many sources in one archive — `rootUrls` is a set, no voting.** The FHIR R4
  importer entities key each resource under the root of the URL it arrived on
  (per response, inside the entities), so one archive can span several servers
  and keep each apart. `Preview.rootUrls` is the **distinct set** of source
  roots the archive reached, in first-seen order — never a single
  inferred/"winning" root. `rootOf` (per URL) is folded over the responses to
  collect them; do not reach for a `firstSomeOf`/most-common shortcut that
  would collapse a two-server capture to one. The resources themselves never
  collide: two `pat-*` from different servers get different ids because each is
  keyed under its own root.
- **`bodyAbsent` is its own count, distinct from a parse failure.** An archive
  can record an exchange while storing no body (`ArchivedExchange.bodyAbsent`);
  the entity is never run, so it is neither a decoded resource nor a decode
  failure. `bodyAbsentCount` surfaces it separately — a reader who folds it into
  `parseFailures` reports a decode that never happened.
- **The mapping to `Extraction.Input` is restated, not passed through.** Neither
  `web-trace-core` nor `importer-fundamentals` imports the other, so
  `toInput` is the only place their alignment is checked. `HeadersWire`
  (`ArchivedExchange.headers`) is exactly `ImportableResponse.Headers` — an
  ordered `[name, value]` list — so the map is a re-statement, and a compile
  error if either drifts.
- **`meta.source` is single-valued and last-writer-wins.** `withMetaSource`
  stamps the HAR-archive `DocumentReference` reference, preserving whatever else
  the resource's `meta` carried. It is the convenient back-pointer, not an
  authoritative multi-source record.
- **`ImportPreview.persist` never throws and one bad write never stops the
  rest** — both delegated to `fhir-r4`'s `persistResources`, which returns
  `ResourceWriteFailure`s as data on a `never` error channel. The importer adds
  the source stamp and nothing else around the write; a test pins the delegation
  so a future refactor can't quietly reintroduce a throwing path.

## Testing

Property-based where a property earns it (an archive of arbitrary non-FHIR
traffic is always `NoImporterClaims`), example-based for the shaped fixtures.
Two fixture routes reach the same `Preview` assertions — a HAR built through
`web-trace-core`'s own `emitHar` from constructed exchanges, and the committed
Chrome DevTools export — so the pipeline is held against both an archive shaped
like ours and a foreign one. The write half runs over the real
`FhirR4ResourcesHttpApiClient` layer against a recording stub `HttpClient`, with
retry backoff on `TestClock`.

## References

- [slices/importer/AGENTS.md](../AGENTS.md) — why this slice exists and its
  guardrails.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `Extraction` / `Recognizer` / `Importer` vocabulary this package assembles.
- [fhir-r4-importer AGENTS.md](../fhir-r4-importer/AGENTS.md) — the FHIR R4
  importer project (`fhirR4Importer`).
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec and `withMetaSource`.
- [slices/emr/AGENTS.md](../../emr/AGENTS.md) — `fhir-r4`'s `persistResources`
  and `ResourceWriteFailure`.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
