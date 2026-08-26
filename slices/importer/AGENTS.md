# AGENTS.md — slices/importer

Turns an archived capture — an uploaded `.har` file — into FHIR resources in
the on-device store. The importer is a **standalone offering**: it owns the
whole vocabulary of importing (entities, recognition, extraction), detects
which registered importer understands an archive, extracts a preview, and
persists only on an explicit confirm. The `collector` slice _builds on_ this
slice — a live collector layers navigation and persistence machinery on top of
an importer project's entities — and nothing here imports from or refers to
collectors.

Part of the offline FHIR HAR importer epic (#489).

## Package roles

- **`importer-fundamentals`** — the vocabulary of importing, exported as
  `effect`-style namespaces: `EntityDefinition` / `UrlMatch` /
  `ImportableResponse` (how one response decodes into resources), `Extraction`
  (`Extraction.run`, the fold of archived responses through an importer's
  entities), `Recognizer` (`Recognizer.resolve`, which importer claims a
  response set), and `Importer` (`Importer.Importer`, an importer as one
  first-class value). Imports from no slice; `collector-fundamentals` depends
  on it, never the reverse. See its [AGENTS.md](./importer-fundamentals/AGENTS.md).
- **`fhir-r4-importer`** — the first per-source **importer project**: the FHIR
  R4 entities (the single definition of how FHIR R4 traffic decodes), the
  recognition surface (`fhirR4Recognizer`, `fhirRootOf`), the importer
  entities (`fhirR4ImporterEntities`, keying each resource under the root of
  the URL it arrived on), and the assembled `fhirR4Importer` value. Pure like
  a `-core`; the live `fhir-r4-client-collector` depends on it, never the
  reverse. See its [AGENTS.md](./fhir-r4-importer/AGENTS.md). Sibling projects
  for other sources (`shoppers-drugmart-importer`, `rexall-be-well-importer`,
  `web-trace-importer`) follow the same shape.
- **`importer-core`** — the pure assembly: read a HAR archive
  (`HarImport.run`), detect which registered importer claims its traffic (the
  closed `importers` list), extract into an `ImportPreview.ImportPreview`,
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

The import is assembled from pieces that each already have a home, and the
assembly belongs to none of them:

- **`importer-fundamentals`** owns the FHIR-agnostic machinery
  (`Extraction.run`, `Recognizer.resolve`, the `Importer` shape) but names no
  archive format and no resource type.
- **`fhir-r4-importer`** owns the FHIR R4 surface (`fhirR4Importer` and the
  entities under it) but knows nothing about HAR or about a closed registry of
  importers to choose between.
- **`web-trace-core`** (in `slices/web-trace`) owns the HAR codec but is
  deliberately importer-agnostic.

`importer-core` is the one place those three meet: HAR text in, a detected
importer, an extracted preview, and an opt-in write out.

## Guardrails

- **The read half never writes.** `HarImport.run` requires no services — in
  particular not `FhirR4ResourcesHttpApiClient` — so a preview is a pure function
  of the archive text and the write client is unreachable from it by
  construction. Writing is `ImportPreview.persist`'s separate step, gated on the
  user confirming the preview. This split is the whole point of a
  preview-then-confirm flow; do not collapse it.
- **The registry is closed and compile-time.** `importers` is a literal list.
  Registering an importer is one static edit — appending the
  `Importer.Importer` value its importer project assembles. Only `fhir-r4` is
  registered so far.
- **The slice imports only the accepted seams.** `importer-core` depends on
  `web-trace-core` (HAR codec + `withMetaSource`), `importer-fundamentals`
  (extraction + recognizer + the `Importer` shape), the per-source importer
  projects (`fhir-r4-importer`'s `fhirR4Importer`), and `fhir-r4` (resources +
  the persist sink). It re-derives none of them. An importer project depends on
  `importer-fundamentals` and the resource/dialect packages it decodes with —
  never on anything in `slices/collector` (the dependency points the other
  way) and never on `importer-core`.
- **Nothing in this slice references collectors.** Not in imports, not in
  names, not in copy. The live collector consumes importer projects; how it
  does so is its own slice's story.

## References

- [importer-fundamentals AGENTS.md](./importer-fundamentals/AGENTS.md) — the
  vocabulary packages here are written against.
- [importer-core AGENTS.md](./importer-core/AGENTS.md) — module layout, the
  detect→extract→preview→persist pipeline, and traps.
- [fhir-r4-importer AGENTS.md](./fhir-r4-importer/AGENTS.md) — the FHIR R4
  importer project (`fhirR4Importer` and its surface).
- [web-trace-core AGENTS.md](../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec (`fromHarJson`, `ArchivedExchange`) and `withMetaSource`.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
