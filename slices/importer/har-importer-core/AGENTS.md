# AGENTS.md — slices/importer/har-importer-core

The **HAR binding** of the importer slice: the concrete
`FileImporterDescriptor` for format `'har'`, assembled from three seams that each
already have a home. It is where the resource-agnostic `importer-fundamentals`
contract is bound to a concrete format (HAR) and resource type (FHIR). No DOM, no
`fs`, no React: HAR text in, FHIR resources out, an opt-in write through the
shell's shared `persistBatchBundle`.

## Shape

- **The HAR 1.2 format itself now lives in the `http-archive` package**
  (`slices/file-formats/http-archive`): `Har`/`HarFromJson`, `emitHar`, and the
  `HttpArchive` projection (`Entry`, `Log`, `LogFromHarJson`). It was the `/har`
  subpath of this package until it was hoisted into the `file-formats` slice so
  the anonymizer could consume it without reaching into the importer. This
  binding consumes it from `decode-har.ts`.
- `src/archive/` — **the FHIR encoding of an uploaded `.har` file** as a
  `DocumentReference`. A thin config + re-export shim over
  `importer-fundamentals`' shared **`sourceArchiveCodec`**: it passes HAR's
  coding, `application/json` content type, and the web-trace raw `securityLabel`
  in as data and re-exports only what the binding consumes —
  `HAR_ARCHIVE_CATEGORY_TOKEN` (`codec.categoryToken`),
  `harArchiveFromDocumentReference`, `isHarArchive`, and `sourceArchive`. (The
  codec logic itself moved from `web-trace-core/codec/har-archive-codec.ts` here
  in M1 of #578, then to the shared builder in fundamentals; the encode
  direction, the wire builder, and the schema aliases are no longer re-exported
  per format — the shared builder's own test covers that machinery.) A whole
  archive lives as one attachment under the `har-archive` category, disjoint
  from a trace on the same axis (`isHarArchive` / `isWebTrace` never both hold).
  Exported as the `/archive` subpath. Re-exports `HAR_ARCHIVE_CODE` and
  `WEB_TRACE_CODE_SYSTEM` so a downstream reader can build the search token from
  one import.
- **`sourceArchive`** — the descriptor's `sourceArchive`, now the shared
  `sourceArchiveCodec.sourceArchive` re-exported through `src/archive/` (the
  standalone `src/source-archive.ts` was folded into the builder). It derives a
  deterministic id from the file's SHA-256 and name, mints the upload instant,
  and encodes to a `DocumentReference` — **no PUT**. The shell shows it in the
  review as a "Source file" section and writes it in the same
  `persistBatchBundle` as the extracted resources; re-importing the same file
  upserts rather than duplicating.
- `src/har-importer.ts` — **`harImporterDescriptor`**, the one value the shell's
  registry lists. Binds `TParsed = FhirResource`. Its `decode` runs the whole read half:
  `decodeHar`, then `review.ts`'s `preview` over the pool filtered by the
  settings' enabled kinds, folded into the `DecodedFile` the shell reviews —
  one `LabeledSection` per URL (first-seen order, only responses that parsed
  to at least one resource) plus one diagnostic note per response that
  yielded nothing (no kind matched, every matching kind disabled, parse
  failure, body absent, duplicate). Resource keys are `responseId:index` —
  independent of the kind toggles, so a settings change re-decodes to the
  same keys for the resources that survive it.
- `src/review.ts` — the **HAR preview pipeline**: `preview(pool, responses,
enabledKinds)` recognizes each response (`Extraction.recognize`), takes its
  top-specificity enabled candidate (`pickFor` — there are no per-response
  overrides), and parses the chosen ones (`Extraction.parseWith`), folding
  every non-resource outcome to data so one bad response cannot abort the
  batch. Consumed by the descriptor's decode; the per-resource selection
  (exclude/edit) lives in `importer-fundamentals`' `Review`.
- `src/decode-har.ts` — **`decodeHar`** (the byte-level parse step) and
  `toInput`. `HttpArchive.LogFromHarJson` (`http-archive`) decodes the
  archive into an `HttpArchive.Log`; each `HttpArchive.Entry` is restated
  field-for-field as an `Extraction.Input` via `toInput`. Restated explicitly,
  not passed through, so a drift between `HttpArchive.Entry` and
  `Extraction.Input` is a compile error here — the one seam the two packages
  (neither of which imports the other) meet.
  Requires nothing and writes nothing; fails only with a `ParseError` on a
  malformed file.
- `src/fhir-pool.ts` — **`fhirSources`**, the registered `SourceDescriptor`s —
  `fhir-r4-source`'s `fhirR4Source`, `rexall-be-well-source`'s
  `rexallBeWellSource`, and `shoppers-drugmart-source`'s `shoppersDrugMartSource`.
  `har-importer-react`'s settings picker groups its include toggles by these;
  the flat pool responses are recognized and decoded through is
  `SourceDescriptor.poolOf(fhirSources)` — derived from the same list, so the
  toggles and the recognizer route can never disagree. The kinds are consumed
  **pre-adopted** (each resource already keyed under the root of the URL it arrived
  on), never re-adopted here. Registering another source is one static append to
  `fhirSources`.
- `src/anonymizer/` — **the shape-preserving pseudonymizer** behind the
  anonymized `.har` export. `shapes.ts` is `detectShape` / `generateFake`: the
  classes (`iso8601`, `dotNetDate`, `jwt`, `uuid`, `email`, `currency`,
  `postalCode`, `phone`, `epochMillis`, `numericId`, `alphanumericId`,
  `freeText`) are ordered most-specific-first and disjoint by construction, and
  every generator re-detects to its own class. A value a consumer parses with a
  regex needs its own class — `/Date(…)/` read as free text scrambled the word
  and broke `lifelabs-source`'s date parse — so add a leaf shape before loosening
  `freeText`, and extend the example table in `shapes.test.ts` when you touch a
  pattern. `redact.ts` is the policy and the derivation loop; `leaves.ts` the
  traversal. See [Anonymization Explanation](../../anonymizer/docs/Anonymization%20Explanation.md).
- `src/har-settings.ts` — **`HarSettings`** `{ disabledKinds }`, default the
  empty list: the kind names turned off for an import. Stored as the
  _disabled_ list so a newly registered kind is on by default. A pre-decode
  setting — the shell re-decodes a HAR file when it changes, and `decode`
  folds a disabled kind's responses into notes rather than sections.

## Layering

Depends on `http-archive` (the HAR format + `HttpArchive` projection it decodes
through), `importer-fundamentals` (the contract), `http-extraction-fundamentals`
(`Extraction.Input`), `fhir-r4-source` (the pre-adopted pool), `web-trace-core`
(`sha256Base64` from `capture`, and the trace-side codec constants the archive
codec still shares — transitional until #578 dissolves that slice), `fhir-r4`
(resources + `persistResources`), and `effect`. Never imports `importer-react`,
`har-importer-react`, or `slices/collector`.

## Guardrails

- **The read half never writes.** `decodeHar` requires no services, so the write
  client is unreachable from a decode by construction. Writing is the shell's
  shared `persistBatchBundle`, gated on a confirmed review; no descriptor field
  takes a write client.
- **The pool is consumed pre-adopted, never re-adopted.** `fhirR4Source`'s
  `responseKinds` are already wrapped with `adoptUnderRecognizedRoot` in
  `fhir-r4-source`; adopting again would hash a hash. Live and archive share
  that single definition by reference.
- **Per-URL, not per-archive.** Recognition against `fhirPool` is per response
  (highest specificity wins), so a mixed archive extracts every recognized URL.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and why
  the three seams meet here.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporterDescriptor` contract this binding implements.
- [har-importer-react AGENTS.md](../har-importer-react/AGENTS.md) — the HAR UI
  over this descriptor.
- [fhir-r4-source AGENTS.md](../../http-extraction/fhir-r4-source/AGENTS.md) — the
  `fhirR4Source` descriptor whose pre-adopted kinds the pool flattens.
- [http-archive AGENTS.md](../../file-formats/http-archive/AGENTS.md) — the HAR
  format + `HttpArchive` projection this binding decodes through.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) —
  `withMetaSource` and the trace-side codec constants the archive codec shares.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
