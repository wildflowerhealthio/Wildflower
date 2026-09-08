# AGENTS.md — slices/importer/har-importer-core

The **HAR binding** of the importer slice: the concrete
`FileImporterDescriptor` for format `'har'`, assembled from three seams that each
already have a home. It is where the resource-agnostic `importer-fundamentals`
contract is bound to a concrete format (HAR) and resource type (FHIR). No DOM, no
`fs`, no React: HAR text in, FHIR resources out, an opt-in write behind the
descriptor's `persist`.

## Shape

- `src/har/` — **the HAR 1.2 format**, as one schema read in both directions.
  Moved from `web-trace-core/har` (M1 of #578): `har.ts` is the format
  (`Har`, `HarFromJson`); `emit.ts` builds an archive from `TraceExchange`es
  (which still live in `web-trace-core` until the epic dissolves that slice);
  `http-archive.ts` is the projection an importer and a replay consume, as the
  `HttpArchive` namespace (`Entry`, `Log`, `LogFromHarJson`). Exported as the
  `/har` subpath. See its `har/index.ts`.
- `src/archive/` — **the FHIR encoding of an uploaded `.har` file** as a
  `DocumentReference`. Moved from `web-trace-core/codec/har-archive-codec.ts`.
  A whole archive lives as one attachment under the `har-archive` category,
  disjoint from a trace on the same axis (`isHarArchive` / `isWebTrace` never
  both hold). Exported as the `/archive` subpath. Re-exports
  `HAR_ARCHIVE_CODE` and `WEB_TRACE_CODE_SYSTEM` so a downstream reader can
  build the search token from one import.
- `src/har-importer.ts` — **`harImporterDescriptor`**, the one value the shell's
  registry lists. Binds `TParsed = FhirResource`, `R =
FhirR4ResourcesHttpApiClient`, and wires the three seams below plus the empty
  `HarSettings`.
- `src/decode-har.ts` — **`decodeHar`** (the read half's only step) and
  `toInput`. `HttpArchive.LogFromHarJson` (`web-trace-core/har`) decodes the
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
  The descriptor exposes only these (so the review menu groups its include toggles
  by source); the flat pool responses are recognized and decoded through is
  `SourceDescriptor.poolOf(fhirSources)` — derived on demand, never stored, so the
  menu and the recognizer route can never disagree. The kinds are consumed
  **pre-adopted** (each resource already keyed under the root of the URL it arrived
  on), never re-adopted here. Registering another source is one static append to
  `fhirSources`.
- `src/persist-fhir.ts` — **`persistFhir`**, the descriptor's write sink:
  `withMetaSource` (`web-trace-core`) stamps each resource's `meta.source` with
  the source archive `sourceRef`, then `fhir-r4`'s `persistResources` writes them
  with bounded retries/concurrency and failure-as-data. Its `ResourceWriteFailure`
  satisfies `importer-fundamentals`' `PersistFailure` structurally, so a drift is
  a compile error here. An empty `resources` never touches the client.
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
  traversal. See [Anonymization Explanation](./docs/Anonymization%20Explanation.md).
- `src/har-settings.ts` — **`HarSettings`**, an empty record. A HAR archive has no
  user-tunable knobs today; the seam is present (`defaultSettings`, a no-op
  `SettingsPicker` in the React package) so a future format with real settings
  slots in without the shell learning a new shape.

## Layering

Depends on `importer-fundamentals` (the contract), `http-extraction-fundamentals`
(`Extraction.Input`), `fhir-r4-source` (the pre-adopted pool), `web-trace-core`
(`TraceExchange` for `emitHar` — transitional until the slice dissolves —
`sha256Base64` from `capture`, and the trace-side codec constants the archive
codec still shares), `browser-sniffer-core` (`HeadersWire` for the archive
projection), `fhir-r4` (resources + `persistResources`), and `effect`. Never
imports `importer-react`, `har-importer-react`, or `slices/collector`.

## Guardrails

- **The read half never writes.** `decodeHar` requires no services, so the write
  client is unreachable from a decode by construction. Writing is `persistFhir`'s
  separate step behind the descriptor's `persist`, gated on a confirmed review.
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
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec and `withMetaSource`.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
