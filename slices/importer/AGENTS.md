# AGENTS.md — slices/importer

The **importer**: the user-facing offering that turns a file the user picked
into FHIR resources in the on-device store, previewed first and persisted only
on an explicit confirm. The slice is the app-facing flow plus per-file-format
import pipelines — HAR today; a future CSV or DICOM importer would join as a
sibling pipeline wrapping a pure decode dialect, never touching
`slices/http-extraction`. The HAR importer is the one format whose contents
_are_ HTTP traffic, so it alone reaches into the `http-extraction` slice to
detect which registered HTTP source claims an archive and to extract with that
source's entities.

Part of the offline FHIR HAR importer epic (#489).

## Package roles

- **`importer-core`** — the pure assembly: read a HAR archive
  (`HarImport.run`), detect which registered HTTP source claims its traffic
  (the closed `sources` list), extract into an `ImportPreview.ImportPreview`,
  and — as a separate, opt-in step — persist the previewed resources
  (`ImportPreview.persist`). No DOM, no `fs`, no React. See its
  [AGENTS.md](./importer-core/AGENTS.md).
- **`importer-react`** — the browser UI adapter: `ImporterScreen`, the whole
  preview-then-confirm flow a host app mounts. It picks one or more HARs (local
  files dropped or chosen as a batch, or a single archive already on the device's
  FHIR server), previews each through `HarImport.run` in one combined view writing
  nothing, and — only on an explicit confirm — uploads each local file's archive
  and persists its resources through `ImportPreview.persist`, best-effort so one
  file's failure does not stop the rest. See its
  [AGENTS.md](./importer-react/AGENTS.md).

A host that provides the FHIR write client and the authed runner sits above
`importer-react` and mounts `ImporterScreen`.

## Why this slice is layered this way

The HAR import is assembled from pieces that each already have a home, and the
assembly belongs to none of them:

- **`http-extraction-fundamentals`** (in `slices/http-extraction`) owns the
  FHIR-agnostic machinery (`Extraction.run`, `Source.resolve`, the
  `Source` shape) but names no archive format and no resource type.
- **`fhir-r4-source`** (same slice) owns the FHIR R4 surface (`fhirR4Source`
  and the entities under it) but knows nothing about HAR or about a closed
  registry of sources to choose between.
- **`web-trace-core`** (in `slices/web-trace`) owns the HAR codec but is
  deliberately consumer-agnostic.

`importer-core` is the one place those three meet: HAR text in, a detected
source, an extracted preview, and an opt-in write out.

## Guardrails

- **The read half never writes.** `HarImport.run` requires no services — in
  particular not `FhirR4ResourcesHttpApiClient` — so a preview is a pure function
  of the archive text and the write client is unreachable from it by
  construction. Writing is `ImportPreview.persist`'s separate step, gated on the
  user confirming the preview. This split is the whole point of a
  preview-then-confirm flow; do not collapse it.
- **The registry is closed and compile-time.** `sources` is a literal list.
  Registering an HTTP source is one static edit — appending the
  `Source.Source` value its source package assembles. Only `fhir-r4` is
  registered so far.
- **The slice imports only the accepted seams.** `importer-core` depends on
  `web-trace-core` (HAR codec + `withMetaSource`), `http-extraction-fundamentals`
  (extraction + recognition + the `Source` shape), the per-source packages
  (`fhir-r4-source`'s `fhirR4Source`), and `fhir-r4` (resources + the persist
  sink). It re-derives none of them. Nothing here imports from
  `slices/collector`, in code or in concept.
- **A future file format gets its own pipeline, not a widened HAR one.** A CSV
  or DICOM import decodes a _document_: its decode belongs in a pure dialect
  package (the way rexall's carebook dialect and `web-trace-core`'s codec
  work), wrapped here by a sibling `*-importer` pipeline and — if the same
  source is ever reachable over HTTP — wrapped separately by an entity in
  `slices/http-extraction`. The dialect sits below both transports, which is
  what keeps the graph acyclic.

## References

- [importer-core AGENTS.md](./importer-core/AGENTS.md) — module layout, the
  detect→extract→preview→persist pipeline, and traps.
- [importer-react AGENTS.md](./importer-react/AGENTS.md) — the
  preview-then-confirm flow.
- [slices/http-extraction/AGENTS.md](../http-extraction/AGENTS.md) — the
  vocabulary and source packages the HAR importer detects and extracts with.
- [web-trace-core AGENTS.md](../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec (`fromHarJson`, `ArchivedExchange`) and `withMetaSource`.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
