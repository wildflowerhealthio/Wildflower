# AGENTS.md — slices/synthetic-data/synthetic-data-core

The **snapshot assembler**: generated records, run through Wildflower's own
importers, as a `Snapshot` of a FHIR store at one as-of date and generator
commit — its header and its entries, and the files a static host serves them
as — and the reader that fetches them back. It knows nothing of any one
pharmacy or importer: it lays out importer output. No DOM, no `fs`, no React
— the data repo's emit step writes the files, and the synthetic data loader,
`synthetic-data-react`, reads them through `Snapshot.Reader`, with a
`FileFetcher` it supplies, and writes what it reads to a FHIR server.

## Shape

The root entry exports two namespaces:
`import { Snapshot, SnapshotFile } from 'synthetic-data-core'`. `Snapshot`
nests `Snapshot.Entry`, `Snapshot.Header`, `Snapshot.Layout`,
`Snapshot.Reader` and `Snapshot.WriteOrder`. Each module is a namespace in the
`effect` style: the file is the noun, the principal type shares the
namespace's name, a union of cases is `Any`, and a value's file codec is a
`Schema` transform (decoded value ⇄ encoded file).

- `src/snapshot.ts` — **`Snapshot`**: the principal type `Snapshot`
  (`header`, and `entries`, every entry once in path order). `assemble(asOf,
wildflowerCommit, members)` lays out each `MemberRecords` (`member`, and
  the importer output of their records), merges them (an entry two members
  share, such as a family account's HAR, is held once and listed under both)
  and builds the header; it fails as `Layout.layOut` does, with
  `ConflictingFiles` for two members' different entries at one path, or with
  a `ParseError` for a header that is not valid (two members under one key).
  `filesOf(snapshot)` encodes the header and every entry: the
  `SnapshotFile.Any`s to write, in path order.
- `src/snapshot-entry.ts` — **`Snapshot.Entry`**: `Any` is `Resource` (a
  stored resource, as `fhir-r4` decodes it, with an id) or `Attachment` (a
  file an importer read: its `format`, `'har' | 'dicom'` from
  `SOURCE_FILE_IMPORTERS` (`harImporter`, `dicomImporter`), its `fileName`,
  the source file's `title`, and its `bytes`). A source-file
  `DocumentReference`'s `Resource` names its `Attachment` by `attachmentPath`;
  its one attachment then carries neither `data` nor `url`. `pathOf` places
  an entry: `fhir/<ResourceType>/<id>.json` or `<format>/<file name>`.
  `FileSchema` (`ResourceFileSchema`, `AttachmentFileSchema`) is each entry's
  codec to its file: a resource is the JSON `FhirResourceSchema` encodes it
  to, a linked source file's attachment carrying `attachmentPath`, relative
  to the snapshot's root, as `url`, and decoding checks the path is the
  resource's own; an attachment is its bytes.
  `ResourcePathSchema` and `AttachmentPathSchema` are the path grammars
  (allowlists: no separators, no parent directories). `withAttachmentData`
  carries a linked attachment's bytes inline again, as the import wrote them.
- `src/snapshot-header.ts` — **`Snapshot.Header`**: `index.json`. `Schema` is
  its one definition: `schemaVersion` (`1`), `asOf`, `generator` (`name`, the
  caller's `wildflowerCommit`), `people` (each a `MemberListing`: the
  `Member`'s `key`, `displayName` and `summary`, their `patientIds`, and the
  paths of their `resources` and `staticFiles`, the attachments) and `totals`
  (members and distinct entries), checked against the members and for unique
  keys. `FileSchema` is its codec to its file at `PATH`. `make(asOf,
wildflowerCommit, members)` builds it from each member's laid-out entries:
  members in the order given, every list sorted and distinct, Patient ids
  read off the member's Patient resources. `pathsOf(header, memberKeys)` is
  the reader's side: a `MemberPaths` of the chosen members' resource and
  attachment paths, each once, in path order.
- `src/snapshot-layout.ts` — **`Snapshot.Layout`**: `layOut(resources)`
  turns importer output (source-file `DocumentReference`s included) into
  entries, in path order: one `Resource` per `<ResourceType>/<id>` (a repeated
  id keeps its last copy, as a batch of PUTs would), and for each source file
  `PickedFile.isSourceFile` claims for one of `SOURCE_FILE_IMPORTERS`, its
  inline data as an `Attachment` its `Resource` links. Ids are kept, so every
  `meta.source` still resolves. Fails with `UnplaceableResource` for a
  resource with no FHIR id, a source file with no data or a title that is not
  a plain file name, or a `meta.source` naming a source file not laid out
  with it (`MetaSource.makeReference`), and with `ConflictingFiles` for two
  entries at one path that are not written as the same file, also across the
  lists `merge` joins.
- `src/snapshot-reader.ts` — **`Snapshot.Reader`**: reading a published
  snapshot back. `FileFetcher` is where a reader fetches files (`text(path)`,
  `bytes(path)`, each failing as `UnreadableFile`), supplied by the caller.
  `readHeader(fetcher)` decodes `index.json` with `Header.FileSchema`.
  `readResource(fetcher, path)` checks `path` against `ResourcePathSchema`
  before fetching anything, decodes the file with `Entry.ResourceFileSchema`
  (it must hold the resource its path names), requires a source-file
  `DocumentReference` of one of `SOURCE_FILE_IMPORTERS` to link its file at
  `<format>/<title>` (and no other resource to link one), fetches that file,
  checks it against the attachment's `size` and `hash` (base64 SHA-256), and
  carries it inline again (`withAttachmentData`): the resource as the import
  wrote it. Every failure is an `UnreadableFile` (`path`, `reason`) naming
  the file at fault.
- `src/snapshot-write-order.ts` — **`Snapshot.WriteOrder`**: the order a
  reader writes what it read to a FHIR server in. `bundlesOf(resources,
maxEntries)` orders `StoredResource`s, as `Reader.readResource` gives them,
  into the batch bundles to write, each resource in a later bundle than
  every resource among them it references (`referencesOf`: the relative
  `<ResourceType>/<id>` references in it, the id in FHIR's id grammar, a
  versioned `…/_history/<vid>` naming its resource, itself excluded), and no
  bundle over `maxEntries`, a whole number of at least one,
  `MAX_BUNDLE_ENTRIES` (200) by default. The order comes from the
  references, not from resource types: a DICOM source file's
  `DocumentReference` references its `ImagingStudy`, while a HAR's
  references nothing. A reference to a resource not being written orders
  nothing, and resources in a reference cycle, and whatever references them,
  share a last round.
- `src/snapshot-file.ts` — **`SnapshotFile`**: the encoded side. `Any` is
  `Text` (`path`, `text`) or `Bytes` (`path`, `bytes`); `jsonTextOf(schema)`
  is a file's JSON text, two-space indented with a trailing newline; `same`
  and `byPath` compare and order files.

`src/test-helpers.ts`, the `./test-helpers` sub-entry, runs generated Rexall
records with a re-identified image, and generated Shoppers family accounts,
through the real importers, and serves a snapshot's files from memory as a
`Snapshot.Reader.FileFetcher` (`fetcherOf`) — for this package's tests and
`synthetic-data-react`'s.

## Layering

Depends on `fhir-r4` (`FhirResourceSchema`, the resource types),
`importer-fundamentals` (`PickedFile.isSourceFile`, `MetaSource`,
`sha256Base64`) and the two importers whose source files a snapshot carries,
`har-importer-core` and `dicom-importer-core` (their `format` and
`sourceFileFormat`). The tests also
use the Rexall, Shoppers and DICOM generators and `synthetic-data-fundamentals`,
as dev dependencies only. Never imports a `-react`, `-node` or `-tauri`
package.

## Rules

- **The published files are a wire format.** The live site and the data repo
  read them: paths, `index.json`'s field names and `schemaVersion`, and every
  file's exact text or bytes. A change to what `filesOf` writes for the same
  inputs is a format change, not a refactor.
- **The layout is lossless.** Every entry's file decodes back to the entry,
  and a linked source file with its attachment's bytes inline again
  (`withAttachmentData`) encodes as the import wrote it;
  `snapshot-layout.test.ts` and `snapshot-reader.test.ts` (`readResource`
  over an assembled snapshot) pin that over real importer output.
- **A reader takes nothing it could not check.** `readResource` fails a file
  whose resource is not the one its path names, a source file that does not
  link its file where the snapshot puts it, another resource that links a
  file, and a linked file that is not the
  bytes its attachment describes.
- **Paths are allowlisted.** Every path an entry sits at and the header lists
  matches `ResourcePathSchema` or `AttachmentPathSchema`, so a reader that
  decodes the header never fetches outside the snapshot.
- **The header is the listing.** A static host cannot list a directory, so
  `index.json` names every entry; its totals are checked against its members.

## Traps

- **A linked source file's `url` is relative,** and `fhir-r4` reads
  `Attachment.url` as an absolute `URL`: a `Resource` holds the link as
  `attachmentPath`, and only its file carries it as `url`. Decode a resource
  file with `Entry.ResourceFileSchema`, never straight through
  `FhirResourceSchema`.
- **`fhir-r4` encodes to its own key order and empty arrays.** A resource's
  file is whatever `FhirResourceSchema` encodes the decoded resource to, so a
  hand-written resource file does not round-trip to the same text; one
  `filesOf` wrote does.
- **Only `harImporter`'s and `dicomImporter`'s source files become
  attachments.** Another importer's source file would be laid out with its
  data inline; add its importer to `SOURCE_FILE_IMPORTERS`.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [importer-fundamentals AGENTS.md](../../importer/importer-fundamentals/AGENTS.md) — `PickedFile`
  and `MetaSource`, how an import records the file it read.
