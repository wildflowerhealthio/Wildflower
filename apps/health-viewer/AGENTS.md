# AGENTS.md — apps/health-viewer

The Synthesized Health Viewer, a SMART-on-FHIR app published to
<https://wildflowerhealth.io/health-viewer-app/> (package `health-viewer-app`),
with a `health-viewer-app-dev` row in debug builds. See [README.md](./README.md)
for the boot structure, the page and how to run it.

`apps/medications-app` is the template: the same two HTML entries, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell, and the
same paged-read drain (`useFetchEveryPage`) and read-status lines.

## Rules

- **Compose; decide nothing.** The app wires `health-viewer-core` and
  `health-viewer-react` together and owns only the SMART shell, the reads, the
  patient and the URL. Which series a record holds, how they are grouped, what
  each axis spans and what window a preset selects are the slice's functions —
  `readRecord`, `groupForPanel`, `ValueAxis.assign`, `Series.extentOfAll`,
  `xDomain`. No domain package is imported here: `health-viewer-observations`
  and `health-viewer-medications` arrive through core.
- **The page is patient → record read → layout.** `App` settles on the
  patient; `useRecordRead` owns every record read and folds them into one
  `RecordRead`; `PatientRecord` renders from it. A new record source is a
  `RecordSourceRead` and its lines in `useRecordRead` — never a branch in a
  component. See the README's "Adding a record source".
- **The URL is the selection's only home.** `useUrlSelection` initialises from
  `decodeSelection` and writes every change back with `encodeSelection`
  through `history.replaceState` (never `pushState` — a checkbox is not a
  navigation). Nothing writes the URL on mount: before the handshake completes
  the URL still carries the OAuth `code` / `state` fhirclient reads, and
  replacing the query would lose them.
- **Every selection change is an updater.** Series, range, patient and the
  reconciliation all go through `updateSelection((latest) => …)`, never a
  copy of the selection a render saw, so changes made in one tick compose.
- **Reconcile only a complete record.** Selected ids with no series are
  dropped once every read has no next page — never while one is paging,
  where the series could be on a later page, and never after a failed later
  page, which leaves the record incomplete.
- **Every read pages to the end, concurrently.** Each is drained by
  `react-kitchen-sink`'s `useFetchEveryPage`, which halts on a failed page
  rather than retrying it. The patient picker's read is the exception: it
  pages on its "More patients" button. Every paged read's status is
  `pagedQueryStatusOf`, rendered with `smart-app-react`'s read-status lines.
- **A MedicationRequest's `id` is required.** `fetchMedicationRequestPage`
  decodes through `withMandatoryId(MedicationRequest.Schema)`, so an entry
  without one is dropped and counted in the page's `droppedEntryCount`, which
  the "couldn't be read" note includes. It is never keyed by position.

## Testing

- `use-url-selection.test.ts` — the URL is left alone on mount, and two
  updates issued from one render both land.
- `app.test.tsx` stubs only the handshake. The page reads are the real
  `fhir-r4-react/smart` ones over a stub client whose `request` answers from a
  table of FHIR JSON by URL prefix, so decoding is exercised end to end. Series
  ids and labels in assertions come from core's `readRecord` over the same
  fixtures, never hand-written, so a change to a domain's id grammar or label
  does not silently desynchronise the tests.
- `app-root.test.tsx` — that `AppRoot` mounts the shared shell as the health
  viewer (the landing `h1` is `APP_DESCRIPTIONS.healthViewer.name`); the shell
  itself is tested in `smart-app-react`.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL.

## References

- [slices/health-viewer/AGENTS.md](../../slices/health-viewer/AGENTS.md) — the
  slice this app composes.
- [apps/medications-app/README.md](../medications-app/README.md) — the template.
- [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md) — `fhir-r4-react/smart`'s
  paged reads.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
