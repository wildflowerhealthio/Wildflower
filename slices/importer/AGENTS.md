# AGENTS.md — slices/importer

Turns an **offline** capture — an uploaded `.har` file — into FHIR resources in
the on-device store, with no live sniffer. It is the archive-driven counterpart
of the `collector` slice: where a collector runs a `ScrapingPlan` against a
webview, the importer replays a static archive through a collector's **offline
entities** and previews the result before writing anything.

Part of the offline FHIR HAR importer epic (#489).

## Package roles

- **`importer-core`** — the pure layer: read a HAR archive, detect which
  registered collector understands its traffic, replay that collector's offline
  entities into an `ImportPreview`, and — as a separate, opt-in step — persist
  the previewed resources. No DOM, no `fs`, no React. See its
  [AGENTS.md](./importer-core/AGENTS.md).

Adapters (a React upload/preview screen, a host that provides the FHIR write
client) sit above `importer-core` and drive it; they are not part of this ticket.

## Why this slice exists

The import is assembled from pieces that each already have a home, and the
assembly belongs to neither of them:

- **not `collector-fundamentals`** — that package owns the FHIR-agnostic offline
  machinery (`Replay.replayEntities`, `Recognizer.resolve`) but names no archive
  format and no resource type.
- **not `fhir-r4-client-collector`** — that package owns the FHIR R4 offline
  _surface_ (`offlineEntities`, `fhirR4Recognizer`, `fhirRootOf`) but knows
  nothing about HAR or about a closed registry of collectors to choose between.
- **not `web-trace-core`** — that package owns the HAR codec but is deliberately
  collector-agnostic.

The importer is the one place those three meet: HAR text in, a detected
collector, a replayed preview, and an opt-in write out.

## Guardrails

- **The read half never writes.** `runHarImport` requires no services — in
  particular not `FhirR4ResourcesHttpApiClient` — so a preview is a pure function
  of the archive text and the write client is unreachable from it by
  construction. Writing is `persistPreview`'s separate step, gated on the user
  confirming the preview. This split is the whole point of a preview-then-confirm
  flow; do not collapse it.
- **The registry is closed and compile-time.** `REGISTERED_COLLECTORS` is a
  literal tuple, mirroring `collector-registry`'s `descriptors`. Registering a
  collector is one static edit. Only `fhir-r4` is registered this epic.
- **The slice imports only the accepted seams.** `importer-core` depends on
  `web-trace-core` (HAR codec + `withMetaSource`), `collector-fundamentals`
  (replay + recognizer), `fhir-r4-client-collector` (the offline surface), and
  `fhir-r4` (resources + the persist sink). It re-derives none of them.

## References

- [importer-core AGENTS.md](./importer-core/AGENTS.md) — module layout, the
  detect→replay→preview→persist pipeline, and traps.
- [slices/collector/AGENTS.md](../collector/AGENTS.md) — the live counterpart,
  and `collector-fundamentals/replay` (the offline runner this drives).
- [fhir-r4-client-collector AGENTS.md](../collector/fhir-r4-client-collector/AGENTS.md)
  — the offline surface (`offlineEntities`, `fhirR4Recognizer`, `fhirRootOf`).
- [web-trace-core AGENTS.md](../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec (`fromHarJson`, `ArchivedExchange`) and `withMetaSource`.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
