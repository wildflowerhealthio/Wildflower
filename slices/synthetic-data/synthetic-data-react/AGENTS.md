# AGENTS.md — slices/synthetic-data/synthetic-data-react

The **data set loader's browser layer**: `SyntheticDataScreen` reads a
published data set from its address, lets the reader choose its people, and
loads them into the FHIR server the host app is connected to. What a data set's
files are, how a file reads back into the resource the import wrote, and the
order resources are written in are all `synthetic-data-core`'s; this package
fetches, writes and shows.

## Shape

The root entry exports `SyntheticDataScreen` (`initialDataSetAddress`).

- `src/synthetic-data-screen.tsx` — the screen, top to bottom:
  - the **address form**: a `Data set` field, read by `dataSetRootOf`, whose
    problem shows beside it; the address it starts with is read on mount;
  - the **data set**: its `index.json` read through `DataSet.readManifest` as a
    query keyed on the root (no retry: a static host answers the same twice;
    submitting the same address again refetches it), then a line with the
    as-of day, the totals and the generating commit, and a checkbox per
    person, all checked to begin with;
  - **Load n people**: the chosen people's resource files
    (`DataSetManifest.filesOf`) handed to `useDataSetLoad`;
  - the load's **progress** (`Reading files… n of m`,
    `Writing resources… n of m`), the files that did not read, a defect's
    `ErrorBanner`, or the results.
- `src/use-data-set-load.ts` — `useDataSetLoad`: reads every chosen file with
  `DataSet.readResource` (eight at a time), and only when every one reads,
  writes `WriteOrder.bundlesOf`'s bundles one after another with
  `fhir-r4/clients`' `persistBatchBundle`, through `fhir-r4-react`'s
  `useRunAuthed`. States: `idle`, `reading`, `writing`, `unreadable` (nothing
  written), `done` (every entry's `BatchEntryOutcome`), `failed` (a defect).
  A reset or a newer load makes an older load's updates stale.
- `src/data-set-files.ts` — `dataSetRootOf` (an `http`/`https` address naming
  the data set's folder or its `index.json`, as the root URL every path
  resolves under) and `fetchedFileSource`, the `DataSet.FileSource` that
  `fetch`es each file with `credentials: 'omit'`; a network error or a non-2xx
  is an `UnreadableFile`.
- `src/load-results.tsx` — `LoadResults`: `Wrote n of m resources.`, then
  every resource under `fhir-r4/clients`' `groupByStatus`, failures open with
  the server's issues, successes folded.

## Rules

- **Read everything, then write.** A file that cannot be fetched, holds
  another resource than its path names, or whose source file is not the
  bytes its attachment describes stops the load before the first bundle; the
  alert lists every such file and says nothing was written.
- **Write in reference order.** Bundles come from `WriteOrder.bundlesOf`,
  never a type list, so a server that checks a reference's target on write
  finds it stored. A rejected entry is an outcome, and later bundles still go.
- **The data set's host gets no credentials.** Files are fetched with
  `credentials: 'omit'`, and never through the SMART client: the bearer
  token is for the FHIR server alone.
- **Lock the form while a load runs.** The address, the people and the load
  button are disabled from the first read to the last bundle.
- **The FHIR server comes from route context.** The screen reads its authed
  runner with `useRunAuthed`, so the host mounts it under a router carrying a
  SMART-built context, as `apps/importer-web` does for `importer-react`.

## Testing

- `synthetic-data-screen.test.tsx` builds a data set with
  `synthetic-data-core/test-helpers` (generated Rexall records and image,
  and a Shoppers family account, through the real importers, then
  `DataSet.assemble`), serves it through a stubbed `fetch`, and records every
  bundle the real `persistBatchBundle` posts to a stub FHIR server. It
  asserts what reached the server: every resource once, each after what it
  references, source files with their data inline, only the chosen people,
  nothing on a tampered source file, and the server's rejections shown.
- `data-set-files.test.ts` — the addresses `dataSetRootOf` reads and refuses.

## Traps

- **jsdom's `TextEncoder` is from another realm.** The HAR codec's
  `Uint8ArrayFromSelf` rejects its output, so a generated HAR imports to
  nothing. The screen test replaces the encoder in `vi.hoisted`, before the
  codec's module builds its own.

## References

- [synthetic-data-core AGENTS.md](../synthetic-data-core/AGENTS.md) — the
  layout, the manifest, the reading half and the write order.
- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice.
- [apps/synthetic-data-app](../../../apps/synthetic-data-app/AGENTS.md) — the
  SMART app that mounts the screen.
