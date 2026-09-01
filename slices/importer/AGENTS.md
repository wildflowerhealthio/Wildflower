# AGENTS.md — slices/importer

The **importer**: the user-facing offering that turns a file the user picked
into FHIR resources in the on-device store, reviewed per-URL first and persisted
only on an explicit confirm. The slice is the app-facing flow plus per-file-format
import pipelines — HAR today; a future CSV or DICOM importer joins as a sibling
pipeline wrapping a pure decode dialect, never touching `slices/http-extraction`.
The HAR importer is the one format whose contents _are_ HTTP traffic, so it alone
reaches into the `http-extraction` slice to recognize which registered response
kinds claim each archived response and to extract with them.

The slice mirrors the collector slice's shape: a resource-agnostic
**fundamentals** package under a **format binding** (core + React) under a
**shell**. See the [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
before adding a format.

Part of the offline FHIR HAR importer epic (#489).

## Package roles

- **`importer-fundamentals`** (resource-agnostic, format-agnostic) — the
  `FileImporterDescriptor` contract ("a file-format importer" as one value a
  closed registry lists), the structural `PersistFailure`, and the per-response
  `Review` model: pure selection-state transitions (whole-import kind toggles,
  per-response overrides, default pick = top specificity) plus choose-then-persist
  (`Review.chosen` decodes only the chosen responses). Built on
  `Extraction.recognize` / `parseWith`. No DOM, no `fs`, no React. See its
  [AGENTS.md](./importer-fundamentals/AGENTS.md).
- **`har-importer-core`** (the HAR binding) — the concrete
  `harImporterDescriptor` for format `'har'`, assembled from three seams:
  `web-trace-core`'s HAR codec (`decodeHar`), the FHIR R4 response-kind pool
  (`fhirPool` = the registered `SourceDescriptor`s' kinds flattened — today
  `fhir-r4-source`'s `fhirR4Source`, pre-adopted), and the
  FHIR persist sink (`persistFhir` = `withMetaSource` + `persistResources`). Bound
  to `TParsed = FhirResource`, empty `HarSettings`. No DOM, no `fs`, no React.
  See its [AGENTS.md](./har-importer-core/AGENTS.md).
- **`har-importer-react`** (the HAR UI) — `HarSettingsPicker` (a no-op today) and
  the interactive per-URL `ReviewBody`: a per-URL list of the archive's
  recognized responses, each with a picker among the kinds that matched
  (defaulting to top specificity), whole-import kind toggles, and a collapsible
  no-match section. Presentation over `importer-fundamentals`' pure `Review`
  model. See its [AGENTS.md](./har-importer-react/AGENTS.md).
- **`importer-react`** (the shell) — `ImporterScreen`, the whole
  pick-review-confirm flow a host app mounts, plus the closed `format →
{ descriptor, SettingsPicker, ReviewBody }` registry (`src/registry.ts`). It
  holds per-file review selection state, reads each picked file through the
  descriptor's `decode` writing nothing, and — only on confirm — uploads each
  local file's archive and persists the reviewed, chosen responses. See its
  [AGENTS.md](./importer-react/AGENTS.md).

A host that provides the FHIR write client and the authed runner sits above
`importer-react` and mounts `ImporterScreen`.

## Why this slice is layered this way

The HAR import is assembled from pieces that each already have a home, and the
assembly belongs to none of them:

- **`http-extraction-fundamentals`** (in `slices/http-extraction`) owns the
  FHIR-agnostic machinery (`Extraction.routeTo` / `recognize` / `parseWith`,
  `HttpResponseKind`, `Specificity`) but names no archive format and no resource
  type.
- **`fhir-r4-source`** (same slice) owns the FHIR R4 source descriptor
  (`fhirR4Source`, its `responseKinds` pre-adopted) but knows nothing about HAR
  or about a registry of formats.
- **`web-trace-core`** (in `slices/web-trace`) owns the HAR codec but is
  deliberately consumer-agnostic.

`har-importer-core` is the one place those three meet: HAR text in, a per-URL
recognition against the FHIR pool, and an opt-in write out. `importer-fundamentals`
sits above `http-extraction` and below every binding, exactly as
`collector-fundamentals` does.

## Guardrails

- **The importer is per-URL, not per-archive.** Each response is recognized
  independently against the flat `pool` (highest specificity wins), so a mixed
  archive extracts every recognized URL — a stray FHIR URL inside a portal
  capture extracts, instead of being quarantined to one winning source. Nothing
  claims a whole archive for a single source; each response carries its own
  recognition.
- **The read half never writes.** `decode` requires no services — in particular
  not `FhirR4ResourcesHttpApiClient` — so reaching a review is a pure function of
  the file text and the write client is unreachable from it by construction.
  Writing is the descriptor's `persist`, gated on the user confirming a review.
  Parse now runs at **confirm**, not preview (`Review.chosen` decodes only the
  chosen responses). This split is the whole point; do not collapse it.
- **The registry is closed and compile-time.** `importer-react`'s `formatRegistry`
  is a literal `{ har: … } as const`; its `FormatRegistration` requires all three
  parts (descriptor, `SettingsPicker`, `ReviewBody`), so a format missing one
  fails to compile. Only `har` is registered so far. Unlike the collector slice
  there is no separate registry package — the importer has no HTTP wire union to
  derive.
- **The slice imports only the accepted seams.** `har-importer-core` depends on
  `web-trace-core` (HAR codec + `withMetaSource`), `http-extraction-fundamentals`
  (extraction + recognition), `fhir-r4-source` (the pre-adopted pool),
  `importer-fundamentals` (the contract), and `fhir-r4` (resources + the persist
  sink). It re-derives none of them. Nothing here imports from `slices/collector`,
  in code or in concept.
- **A future file format gets its own binding, not a widened HAR one.** A CSV or
  DICOM import decodes a _document_: its decode belongs in a pure dialect package
  (the way rexall's carebook dialect and `web-trace-core`'s codec work), wrapped
  here by a sibling `*-importer-core` binding implementing the same
  `FileImporterDescriptor`. The dialect sits below both transports, which is what
  keeps the graph acyclic.

## References

- [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the checklist for a new format binding.
- [importer-fundamentals AGENTS.md](./importer-fundamentals/AGENTS.md) — the
  descriptor contract, the `Review` model, and `PersistFailure`.
- [har-importer-core AGENTS.md](./har-importer-core/AGENTS.md) — the HAR binding's
  decode/pool/sink.
- [har-importer-react AGENTS.md](./har-importer-react/AGENTS.md) — the interactive
  per-URL review.
- [importer-react AGENTS.md](./importer-react/AGENTS.md) — the shell + registry
  and the pick-review-confirm flow.
- [slices/http-extraction/AGENTS.md](../http-extraction/AGENTS.md) — the
  vocabulary and source packages the HAR importer recognizes and extracts with.
- [web-trace-core AGENTS.md](../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec (the `HttpArchive` namespace) and `withMetaSource`.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
