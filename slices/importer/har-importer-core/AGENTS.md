# AGENTS.md — slices/importer/har-importer-core

The **HAR binding** of the importer slice: the concrete
`FileImporterDescriptor` for format `'har'`, assembled from three seams that each
already have a home. It is where the resource-agnostic `importer-fundamentals`
contract is bound to a concrete format (HAR) and resource type (FHIR). No DOM, no
`fs`, no React: HAR text in, FHIR resources out, an opt-in write behind the
descriptor's `persist`.

## Shape

- `src/har-importer.ts` — **`harImporterDescriptor`**, the one value the shell's
  registry lists. Binds `TParsed = FhirResource`, `R =
FhirR4ResourcesHttpApiClient`, and wires the three seams below plus the empty
  `HarSettings`.
- `src/decode-har.ts` — **`decodeHar`** (the read half's only step) and
  `toInput`. `fromHarJson` (`web-trace-core/har`) decodes the archive into an
  `ArchivedSession`; each `ArchivedExchange` is restated field-for-field as an
  `Extraction.Input` via `toInput`. Restated explicitly, not passed through, so a
  drift between `ArchivedExchange` and `Extraction.Input` is a compile error here
  — the one seam the two packages (neither of which imports the other) meet.
  Requires nothing and writes nothing; fails only with a `ParseError` on a
  malformed file.
- `src/fhir-pool.ts` — **`fhirPool`**, the flat pool responses are recognized and
  decoded through: the registered `SourceDescriptor`s' kinds flattened — today
  `fhir-r4-source`'s `fhirR4Source` — consumed
  **pre-adopted** (each resource already keyed under the root of the URL it
  arrived on), never re-adopted here. Registering another source is one static
  append of its descriptor to the `sources` list.
- `src/persist-fhir.ts` — **`persistFhir`**, the descriptor's write sink:
  `withMetaSource` (`web-trace-core`) stamps each resource's `meta.source` with
  the source archive `sourceRef`, then `fhir-r4`'s `persistResources` writes them
  with bounded retries/concurrency and failure-as-data. Its `ResourceWriteFailure`
  satisfies `importer-fundamentals`' `PersistFailure` structurally, so a drift is
  a compile error here. An empty `resources` never touches the client.
- `src/har-settings.ts` — **`HarSettings`**, an empty record. A HAR archive has no
  user-tunable knobs today; the seam is present (`defaultSettings`, a no-op
  `SettingsPicker` in the React package) so a future format with real settings
  slots in without the shell learning a new shape.

## Layering

Depends on `importer-fundamentals` (the contract), `http-extraction-fundamentals`
(`Extraction.Input`), `fhir-r4-source` (the pre-adopted pool), `web-trace-core`
(`fromHarJson`, `withMetaSource`), `fhir-r4` (resources + `persistResources`), and
`effect`. Never imports `importer-react`, `har-importer-react`, or
`slices/collector`.

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
