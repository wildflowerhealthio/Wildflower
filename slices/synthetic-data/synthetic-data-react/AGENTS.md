# AGENTS.md — slices/synthetic-data/synthetic-data-react

The synthetic data slice's **browser layer**: loading people from a published
data set into a FHIR server. It reads what `synthetic-data-core`'s
`DataSet.assemble` wrote — `index.json` (`DataSetManifest`) and the
`fhir/<ResourceType>/<id>.json`, `har/` and `dicom/` files it lists — off a
static host, and writes the picked people's resources with `fhir-r4`'s
`persistBatchBundle`. `apps/synthetic-data-app` is the SMART app that mounts it.

## Shape

- `src/synthetic-data-screen.tsx` — `SyntheticDataScreen` (`serverUrl`,
  `dataSetUrl`, `onDataSetUrlChange`, optional `fetchUrl`): the data set URL
  form; the manifest read (one `useQuery` per root, no retry); the people as
  checkboxes, all picked, each with their name, summary and what their files
  hold (`n resources (… per type) · n source files`); the
  `Load into <serverUrl>` button; then the load's progress bar and line, its
  failure line or its results. The data set form, the people and the button
  are disabled while a load runs; submitting the form resets the load and
  reads `index.json` again, even for the same URL.
- `src/data-set-url.ts` — `DEFAULT_DATA_SET_URL` (the Pages site of
  `wildflowerhealthio/synthetic-data`) and `dataSetRootOf`, which accepts an
  `http:` or `https:` URL with no query or fragment and gives it a trailing
  `/`, so every manifest path resolves inside it.
- `src/data-set-read.ts` — `readManifest` and `readResources` over an injected
  `Fetch`, failing with `DataSetReadFailed` (`path`, and a `message` naming
  it). `readResources` fetches `READ_CONCURRENCY` files at a time, decodes each
  through `DataSetLayout.ResourceJsonSchema`, checks the file holds the
  resource its path names, carries a source file's static file inline again
  (below), and decodes it as FHIR.
- `src/load-plan.ts` — `resourcePathsOf` (the picked people's files, each
  once: a family account's HAR source file is shared), `resourceTypeCountsOf`,
  and `writeBatchesOf`: `WRITE_ORDER` (Patient, Practitioner,
  DocumentReference, ServiceRequest, MedicationRequest, MedicationDispense,
  Observation, ImagingStudy, DiagnosticReport; anything else last, by name),
  one type to a bundle and at most `WRITE_BATCH_SIZE` (200).
- `src/use-data-set-load.ts` — `useDataSetLoad`: `idle` → `reading` (files
  read of the count) → `writing` (resources submitted of the count) →
  `loaded` (every `BatchEntryOutcome`) or `failed` (a reason), through
  `fhir-r4-react`'s `useRunAuthed`. A later `start` or a `reset` makes an
  earlier load's updates stale, as `importer-react`'s `useConfirmImport` does.
- `src/load-results.tsx` — `LoadResults`: `Load complete` or
  `Loaded with some failures`, the tally
  (`Wrote n of m resources for <people> to <server>.`), and each echoed status
  as a `<details>`, failures first and open as `role="alert"` with the
  server's issues.

## Rules

- **A source file is written as its import wrote it.** The data set links a
  source file's HAR or DICOM by a relative `attachment.url`; the reader
  fetches it, checks it against the attachment's `size` and SHA-256 `hash`,
  and puts it back as `data` (`DataSetLayout.withStaticFileData`), dropping the
  `url`. Writing the `url` instead, resolved to the data set's absolute URL,
  would leave the stored source file pointing at a third-party host, and the
  importer's server source-file list, which reads a file back from its
  `data`, could not re-import it.
- **Read everything, then write.** A file that cannot be read fails the load
  before any bundle is sent, so a load never leaves part of a person's
  records behind. Once writing starts, each bundle is best-effort:
  `persistBatchBundle` never fails, a rejected entry is a result, and the
  bundles go one after another in `WRITE_ORDER`, one type to a bundle — a
  batch's entries may be applied in any order — so a server that checks
  references on write finds each target of another type already stored.
- **Every path read is in the layout's grammar.** Resource paths come from the
  manifest, which `DataSetManifest.Schema` checks; a static file's path comes
  from its source file's `url`, which `DataSetLayout.staticFileLinkOf` links
  only when it is a `StaticFilePathSchema` path. `dataSetRootOf` gives the root
  a trailing `/`, so a read never leaves the data set. A file is checked to
  hold the resource its path names before its static file is fetched, and the
  files go out with no credentials (`credentials: 'omit'`).
- **The data set form is locked while a load runs.** Reading another data set
  would unmount the load and its results while its writes carry on unseen.
- **The data set URL is the caller's.** The screen reports an invalid one and
  hands a submitted one to `onDataSetUrlChange`; it keeps only the draft.
- **Writes go through router context.** The screen reads its authed runner
  with `useRunAuthed`, as `importer-react` does; the host mounts it under a
  router built with `buildSmartRouterContext`.

## Testing

- `src/data-set.test-helpers.ts` — a two-person data set built by
  `DataSet.assemble` around a HAR source file minted by the importer's own
  codec (`PickedFile.FromDocumentReference`), served by an in-memory static
  host whose files can be replaced or removed.
- `data-set-url.test.ts` — roots accepted and normalized, and the rejections.
- `data-set-read.test.ts` — the manifest; every resource read back encodes
  as imported, the source file with its HAR inline; one callback per file;
  and the failures: a missing file, a file that is not JSON, a static file of
  the wrong size or hash, a file holding another resource (a source file's
  static file left unfetched), a missing or malformed `index.json`.
- `load-plan.test.ts` — a property over generated resources: each written
  once, in type order, read order kept within a type, one type to a bundle
  and each bundle full but a type's last; the picked paths once each; the
  type counts.
- `synthetic-data-screen.test.tsx` — the screen over the fixture host and a
  recording FHIR server, with only `useRunAuthed` replaced: the people and
  counts; a load writing each resource once, in order, exactly as its import
  would put it on the wire; a partial pick; no load with no one picked;
  progress with the people, the button and the data set form locked; a
  rejected entry as a partial
  load with its diagnostic; a read failure writing nothing; the manifest
  failure, and the same URL read again once resubmitted; an invalid URL
  never read; the submitted URL handed back.
