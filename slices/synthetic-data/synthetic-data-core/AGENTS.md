# AGENTS.md — slices/synthetic-data/synthetic-data-core

The **data set assembler**: generated records, run through Wildflower's own
importers, as the files a published data set holds, and the reading half that
turns a laid-out file back into what the import wrote. It knows nothing of any
one source: it lays out importer output. No DOM, no `fs`, no React — the data
repo's emit step writes the files, and the synthetic data app reads them.

## Shape

The root entry exports three namespaces:
`import { DataSet, DataSetLayout, DataSetManifest } from 'synthetic-data-core'`.

- `src/data-set-layout.ts` — **`DataSetLayout`**: where each file lives.
  `layOut(resources)` takes importer output (source-file `DocumentReference`s
  included) and gives one `ResourceFile` per `<ResourceType>/<id>` at
  `fhir/<ResourceType>/<id>.json` (the JSON `fhir-r4`'s `FhirResourceSchema`
  encodes it to; a repeated id keeps its last copy, as a batch of PUTs would)
  and one `StaticFile` per file an importer read. A source file is a
  `DocumentReference` that `PickedFile.isSourceFile` claims for one of
  `SOURCE_FILE_IMPORTERS` (`harImporter`, `dicomImporter`); its data becomes
  `<format>/<title>` (`har/…`, `dicom/…`), and `withStaticFileUrl` rewrites
  its attachment to carry that path, relative to the data set's root, as `url`
  instead of `data`, keeping the importer's `contentType`, `size`, `hash` and
  `title`. Ids are kept, so every `meta.source` still resolves. Fails with
  `UnplaceableResource` for a resource with no FHIR id, a source file with no
  data or a title that is not a plain file name, or a `meta.source` naming a
  source file not laid out with it (`MetaSource.makeReference`), and with
  `ConflictingFiles` for two different files at one path, also across the sets
  `merge` joins. `ResourcePathSchema` and `StaticFilePathSchema` are the path
  grammars (allowlists: no separators, no parent directories). The reading
  half: `ResourceJsonSchema` decodes a resource file's JSON without reading a
  relative `url` as `fhir-r4`'s absolute `URL`, `staticFileLinkOf` finds the
  static file a laid-out source file links to, and `withStaticFileData`, the
  inverse of `withStaticFileUrl`, carries it inline again.
- `src/data-set-manifest.ts` — **`DataSetManifest`**: `index.json`. `Schema`
  is its one definition, which the emit step encodes and a reader decodes:
  `schemaVersion` (`1`), `asOf`, `generator` (`name`, the caller's
  `wildflowerCommit`), `people` (each `key`, `displayName`, `summary`,
  `patientIds`, and the paths of their `resources` and `staticFiles`) and
  `totals` (people and distinct files), checked against the people and for
  unique keys. `manifestOf(asOf, wildflowerCommit, people)` builds it from
  laid-out `PersonFiles`: people in the order given, every list sorted and
  distinct, Patient ids read off the person's Patient files.
- `src/data-set.ts` — **`DataSet`**: `assemble`, given the as-of date, the
  Wildflower commit and the people, lays out each person's records, merges them (a file two people
  share, such as a family account's HAR, is written once and listed under
  both) and adds `index.json`: every `File` (`path`, and `contents` as JSON
  text, two-space indented with a trailing newline, or a static file's bytes)
  in path order.

`src/imports.test-helpers.ts` (test-only) runs generated Rexall records with a
re-identified image, and generated Shoppers family accounts, through the real
importers for the tests.

## Layering

Depends on `fhir-r4` (`FhirResourceSchema`, the resource types),
`importer-fundamentals` (`PickedFile.isSourceFile`, `MetaSource`) and the two
importers whose source files a data set carries, `har-importer-core` and
`dicom-importer-core` (their `format` and `sourceFileFormat`). The tests also
use the Rexall, Shoppers and DICOM generators and `synthetic-data-fundamentals`,
as dev dependencies only. Never imports a `-react`, `-node` or `-tauri`
package.

## Rules

- **The layout is lossless.** Read back through the reading half, every file
  encodes as the import wrote it; `data-set-layout.test.ts` pins that over
  real importer output.
- **Paths are allowlisted.** Every path the layout writes and the manifest
  lists matches `ResourcePathSchema` or `StaticFilePathSchema`, so a reader
  that decodes the manifest never fetches outside the data set.
- **The manifest is the listing.** A static host cannot list a directory, so
  `index.json` names every file; its totals are checked against its people.

## Traps

- **A laid-out source file's `url` is relative,** and `fhir-r4` reads
  `Attachment.url` as an absolute `URL`: decode a resource file with
  `ResourceJsonSchema`, and carry its static file inline
  (`withStaticFileData`) before decoding it as a resource.
- **The Shoppers import holds a prescription's latest fill twice under one
  id** (#803); the layout keeps the last copy.
- **Only `harImporter`'s and `dicomImporter`'s source files become static
  files.** Another importer's source file would be laid out with its data
  inline; add its importer to `SOURCE_FILE_IMPORTERS`.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [importer-fundamentals AGENTS.md](../../importer/importer-fundamentals/AGENTS.md) — `PickedFile`
  and `MetaSource`, how an import records the file it read.
