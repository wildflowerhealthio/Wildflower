/**
 * The synthetic data snapshot assembler: generated records, run through the
 * real importers, as a `Snapshot` of a FHIR store — its header (as-of date,
 * generator, members, totals) and its entries, one per resource and one per
 * file an importer read (`Snapshot.Entry`), laid out from each member's
 * importer output (`Snapshot.Layout`, `Snapshot.assemble`). Each entry kind,
 * and the header, owns its codec to the `SnapshotFile` a static host serves it
 * as — `fhir/<ResourceType>/<id>.json`, `har/…` and `dicom/…`, and
 * `index.json` — and `Snapshot.filesOf` gives them all, in path order.
 *
 * Pure: the step that writes the files, and the app that reads them, are
 * elsewhere.
 *
 * @packageDocumentation
 */
export * as Snapshot from './snapshot.ts'
export * as SnapshotFile from './snapshot-file.ts'
