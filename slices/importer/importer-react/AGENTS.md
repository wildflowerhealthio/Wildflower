# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice, and its **shell**: the whole
pick-review-confirm flow plus the closed `format → { descriptor, SettingsPicker,
ReviewBody }` registry. One surface a host app mounts, reading the authed
runner out of router context:

- **`ImporterScreen`** — pick one or more HARs (local files dropped or chosen,
  or a single archive already on the device's FHIR server), review per-URL
  exactly what every file would write in one combined view, confirm once to
  write the reviewed, chosen responses across the batch (uploading each local
  file's archive first), and read the per-file results. Local picking is a
  **batch**; the server list is single-select.

The anonymize surface is the anonymizer slice's shell
([anonymizer-react](../../anonymizer/anonymizer-react/AGENTS.md)), not part of
this package. This package exports `ServerHarArchiveList` — the
uploaded-archives pick source — which a host passes into that shell's
`serverSource` slot.

## Layering

`importer-react` is an adapter and follows the rule in
[slices/AGENTS.md](../../AGENTS.md): it depends on its sources, never the reverse.
It depends on `importer-fundamentals` (the `FileImporterDescriptor` contract and
the pure `Review` model), `har-importer-core` (the `harImporterDescriptor`,
`HarSettings`, and `HttpArchive.LogFromHarJson`), `har-importer-react`
(`ReviewBody`, `HarSettingsPicker`), `http-archive` (the `HttpArchive`
projection), `web-trace-core` (the HAR archive codec under `/codec` and the HAR
parser under `/har`), `fhir-r4` (the typed client and `ResourceWriteFailure`),
and `fhir-r4-react` (the authed runner and the slice runtime layer).

The seam between this package and a format binding is the **descriptor** and the
`Review` model: the read half runs the descriptor's `decode` (no services, no
writes), the review drives `Review`'s pure transitions, and the write half runs
`Review.chosen` then the descriptor's `persist`. If a component needs more than
the descriptor and `Review` expose, widen those rather than reaching around them.

**Presentation and interaction only.** Nothing here parses HAR, encodes an
archive, runs entities, or writes resources. The parser
(`HttpArchive.LogFromHarJson`), the
archive codec, `decode`, the recognition (`Review.recognize`), and the write sink
(`persist` → `fhir-r4`'s `persistResources`) all live below this package; it
drives them and reimplements none.

## The registry

`src/registry.ts` is the closed, compile-time `format → FormatRegistration` map —
the single edit point for wiring a file-format importer into the shell. A
`FormatRegistration` bundles the three parts a format contributes: its
`descriptor` (data), its `SettingsPicker`, and its `ReviewBody` (the two React
views). The interface requires all three, so a format missing one fails to
compile here. Only `har` is registered (`har-importer-core` +
`har-importer-react`). The importer has no HTTP wire union to derive, so both
halves live here — there is no separate `importer-registry` package the collector
slice needs.

## Module layout

- **`src/importer-screen.tsx`** — the flow, top to bottom. Reads everything from
  router context (no props): `SourcePicker` → `useImportRun` → `PreviewPanel` →
  `useConfirmImport` → `ImportResults`. It holds each read file's
  `Review.Selection`, keyed by the file's stable id (absent = the default, every
  kind enabled, so an untouched file still imports everything recognized). A
  cancel or "import another" discards the read, every review edit, and any confirm
  outcome, and returns to the picker.
- **`src/registry.ts`** — the closed format registry (above).
- **`src/preview/`** — the read half, the review view, and the write action.
  `use-import-run.ts` runs the descriptor's `decode` (via `useRunAuthed`) once per
  picked file and holds the batch of `FileReadOutcome`s (each a `read` — its
  decoded `Extraction.Input` responses — or an `unreadable` file); `preview-panel.tsx`
  renders every read file's interactive `ReviewBody` under one shared confirm,
  gating the confirm on the batch having at least one **chosen** response
  (`Review.chosenCount` summed across files); `use-confirm-import.ts` is the
  opt-in write action, per file, best-effort — upload-then-persist each file whose
  review chose something, decoding **only** the chosen responses (`Review.chosen`),
  one file's failure never stopping the rest.
- **`src/results/`** — the outcome. `import-outcome.ts` is the pure fold: the
  per-file `ImportOutcome` and the `FileImportResult`/`BatchOutcome` aggregate
  (`summarizeBatch`, `isPartialBatch`), all on `collectImportSummary` semantics
  (any failure ⇒ partial); `import-results.tsx` renders a per-file breakdown —
  writes with their provenance link, failed uploads with their cause, and skipped
  files — under one aggregate tally.
- **`src/sources/`** — the picker. `picked-file.ts` is the vocabulary
  (`PickedFile` — `{ fileName, bytes, source }` — the `local` / `server`
  `PickedFileSource`, and `harArchiveReference` — the one spelling of a
  `DocumentReference/<id>` reference); `local-file.ts` is the format-blind
  "read a local file's bytes and identify it against the registered
  descriptors' `detect`" gate — no descriptor's `decode` runs at pick time;
  `server-har-archive-list.tsx` is the uploaded-archives pick source (rows,
  paging, the fetch-and-decode of a selected row), exported for the
  anonymizer shell's `serverSource` slot as much as used here;
  `source-picker.tsx` composes the drop-and-pick zone, the file input it
  opens, and that server list. Two modes: `'batch'` (default; the importer
  flow) accepts several files in one pick; `'single'` trims the accepted
  list to the first file and drops the OS dialog's `multiple` attribute —
  the server list is single-select in both.
- **`src/queries/`** — the reads. `har-archives.ts` is the paged
  `DocumentReference` search pinned to the HAR-archive category, plus
  `fetchHarArchive` — the one-archive fetch-and-decode a row selection runs;
  `page-token.ts` pulls the continuation cursor out of a bundle's `next` link
  (a copy of the web-trace viewer's, see the trap); `keys.ts` holds the query-key
  roots.
- **`src/mutations/`** — the write. `upload-har.ts` mints a fresh archive from a
  local file's bytes and PUTs it, then invalidates the archive list.

## Traps

- **The read half writes nothing, and the split is the whole product.** Reaching a
  review issues no writes — `decode` requires no services and is run for its data
  only, and the parse of the chosen responses runs at **confirm**, not preview. A
  test pins this on the wire (zero writes to reach a review); do not add a write to
  the read path (e.g. an "auto-upload on pick") that would collapse the opt-in
  seam.
- **`ServerHarArchiveList` never writes.** The list is a search, a selection is
  a `DocumentReference` GET. It is exported into the anonymizer shell's
  `serverSource` slot precisely because it is read-only; do not add a write to
  it.
- **Selection state lives in the shell, not the review body.** `ReviewBody` is
  controlled — the shell passes `selection` in and receives every change via
  `onChange`, and holds the canonical `Map<fileId, Selection>` so it can hand
  the confirm the exact selection each file was reviewed with
  (`Review.chosenResources` over the shared previews). Don't move the
  selection down into the body, or the shell and the view can disagree.
- **Confirm ordering is fixed per file: archive create, then that file's resource
  writes.** A `local` pick's archive is uploaded first (`useUploadHar`) and the
  reference it mints is stamped onto every resource from _that file_; only then
  does the descriptor's `persist` run for it. A `server` pick uploads nothing and
  links to the document it was fetched from. Sequencing matters — a resource must
  never be written pointing at an archive that is not there yet — so each file's
  upload is `flatMap`ped before its persist, inside `importOneFile`. The whole
  batch is one Effect (`Effect.forEach` at unbounded concurrency, `Match`-dispatched
  per file) run through `runAuthed`; cross-file interleaving is fine because each
  resource is stamped with its own file's reference. The upload crosses a TanStack
  mutation, so its `FiberFailure` rejection is `Cause.squash`ed back to the typed
  FHIR-client error before it is stored on the `uploadFailed` result — which is
  what lets the results view render a `ParseError`'s schema tree in full.
- **The batch is best-effort, and provenance stays per-file.** One file's upload
  failure is caught and recorded as its own `FileImportResult` (`uploadFailed`,
  carrying the cause) — the remaining files still import, the multi-file echo of
  `persist` returning per-resource failures as data. A file whose review chose
  nothing (no kind recognized it, or every matching kind toggled off) or that was
  `unreadable` is `skipped`, never a failure. `isPartialBatch` lifts
  `collectImportSummary` to the batch: any upload failure or any per-resource
  failure makes the whole batch partial; a `skipped` file alone does not. There is
  **no** whole-flow `errored` state — an upload failure is a row in the results,
  and its cause is surfaced there (the FHIR server's own response), not swallowed
  behind "Try again".
- **The confirm affordance is gated on the batch having a chosen response to
  write.** `PreviewPanel` shows the single confirm button only when
  `Review.chosenCount` summed across the read files is positive; unreadable files
  and read files whose review chose nothing render their own section but add
  nothing to write. `useConfirmImport` re-checks each file (skipping the ones with
  nothing chosen) — the gate is the affordance, the per-file check is the safety.
- **A HAR archive and a web trace share a code system and nothing else, and the
  disjointness is load-bearing.** The archive list searches `category` for
  `` `${WEB_TRACE_CODE_SYSTEM}|har-archive` `` (`HAR_ARCHIVE_CATEGORY_TOKEN`,
  built from `web-trace-core`'s constants so it cannot drift from what the codec
  writes), and `rowsOf` still guards each entry with `isHarArchive`. The
  web-trace viewer lists traces; this lists archives; `isWebTrace` and
  `isHarArchive` never both hold. The list must never surface a trace.
- **The picker identifies each local file syntactically through the
  registered descriptors' `detect`, not a full parse.** `acceptLocalFile`
  runs `importer-fundamentals`' `identify` over the registered descriptors,
  so every format's `detect` runs on every drop — cheap on purpose — and a
  file no descriptor claims is rejected _at the picker_, next to the control
  the user just used. In a batch the accepted files are handed on together
  and the rejected ones are named in the notice; a **lone** rejected file
  with nothing accepted keeps its own rejection message. The full parse
  still runs in that format's `decode` one step downstream, so a file the
  picker accepted whose bytes are malformed lands in the preview as its own
  `unreadable` row rather than a batch-wide error.
- **`page-token.ts` is a copy of `web-trace-react`'s, deliberately.** The two
  slices page the same FHIR server the same way, but the importer must not depend
  on the web-trace viewer to do it — an adapter reaching into another adapter is
  the wrong layer. A shared paging primitive would belong below both, not in one.
  A present-but-empty `_pageToken=` reads as token-less: `''` is not `null`, so
  TanStack Query would take it for a real cursor and re-request page one forever.
- **The list carries rows, not archives.** An archive's bytes are the whole HAR
  file, potentially megabytes; `HarArchiveRow` holds only the id, title, and
  upload instant, and `fetchHarArchive` reads the one archive the user selects.
  Listing the bytes to render a title would pull every archive onto the device to
  draw a list.
- **A row selection decodes through the archive codec and keeps the bytes
  verbatim.** `fetchHarArchive` runs `harArchiveFromDocumentReference` (a
  resource that is not an archive fails as a `ParseError`, never yields
  nonsense) and returns the archive's `bytes` on the `PickedFile` — every
  downstream step reads bytes (`decode`, and the confirm's upload if the
  pick were local). The `server` source carries `DocumentReference/<id>` so
  a later step links provenance to the stored archive rather than
  re-uploading.
- **Every upload is a fresh document.** `useUploadHar` mints a uuid with
  `crypto.randomUUID()` per call and uses it as both the resource id and the
  `Update` path, so the PUT preserves the client-minted id and two uploads of the
  same bytes are two documents — never one silently overwriting the other. That
  is the archive codec's contract; dedupe stays _detectable_ through the
  attachment's `hash` and `size` without being forced.
- **Upload takes bytes, not text.** The archive codec stores the file
  verbatim so a truncated or mis-encoded upload is preserved and the
  attachment `hash` means something. `UploadHarInput.bytes` is `Uint8Array`;
  every `PickedFile` already carries its bytes, so the caller hands them
  through unchanged.
- **The drop zone is a button, so drop is an enhancement rather than the only
  path.** The zone itself opens the file picker on click, so the whole
  surface is keyboard-reachable and screen-reader named; the
  `<input type="file">` it opens is visually hidden but kept a named,
  reachable input (`aria-label="Import file"`), not `display: none` — some
  upload implementations refuse an invisible input.
- **The authed runner comes from router context, one way.** `useHarArchivesQuery`
  and the picker's row-select both read `useRunAuthed()`; the query also exposes
  `harArchivesInfiniteQueryOptions(runAuthed, options)` taking the runner as its
  first argument, for a loader or a test that drives the query itself. There is no
  prop-threaded second way in — this mirrors `web-trace-react`.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
and [React Testing Reference](../../../docs/Testing/React%20Testing%20Reference.md).
Use the workspace-local `node_modules/.bin/vp` for jsdom runs.

- `sources/source-picker.test.tsx` mocks only the router seam
  (`vi.mock('fhir-r4-react', … useRunAuthed …)`) and drives the whole picker over
  a stub `HttpClient`; the runner is built through `fhir-r4-react/smart`'s
  `buildSmartRouterContext` so a bearer token rides the wire and the test can
  assert `Authorization: Bearer …` and the search URL against the recorded
  requests. The three-paths test synthesizes a `DataTransfer` for the drop,
  uploads to the hidden input for the pick, and clicks a row for the server source;
  the server archive fixtures are hand-built `DocumentReference` JSON with base64
  `data` so a `Uint8Array` from jsdom's realm never has to satisfy the codec's
  `instanceof` check.
- `mutations/upload-har.test.tsx` renders the hook over a _stateful_ stub that
  stores each PUT under its minted id and answers a later search with it, so the
  list refetches on invalidation and the new archive appears as an observed fact;
  it also asserts two uploads of the same bytes produce two distinct ids.
- `importer-screen.test.tsx` is the end-to-end one: it replaces only the router
  seam and drives the whole flow over a recording stub `HttpClient`, reading one
  ordered write log back. It pins the opt-in seam (zero writes to reach a review),
  the confirm ordering (the archive create lands before the first resource write,
  every resource write carries `meta.source`), the server-source case, the
  multi-file batch, the per-file upload failure, the partial-write fold, and
  cancel. It re-wraps `TextEncoder` output through the ambient `Uint8Array` (a
  jsdom single-realm workaround; the production encode stays `new
TextEncoder().encode(text)`).
- `preview/preview-panel.test.tsx` drives the pure panel by props — no router —
  and pins that a read file renders its `ReviewBody`, an unreadable file renders
  its own alert, that a mixed batch sums to one confirm over every file's section,
  and that the confirm appears only when at least one file has a chosen response.
  `results/import-outcome.test.ts` is the property/example test for the folds. The
  interactive review's own behaviour (default pick = top specificity, toggling a
  kind re-recognizes, the no-match fold) is pinned in `har-importer-react`'s
  `review-body.test.tsx`.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles,
  guardrails, and the per-URL pick-review-confirm pipeline this package's flow
  drives.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporterDescriptor` contract and the `Review` model this shell drives.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR
  descriptor (`decode`, `sources`, `persist`) the registry lists.
- [har-importer-react AGENTS.md](../har-importer-react/AGENTS.md) — the
  interactive `ReviewBody` this shell mounts per file.
- [slices AGENTS.md](../../AGENTS.md) — the slice layering rules this package
  follows.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the HAR
  archive codec and the HAR parser this package drives, and the disjointness of
  traces and archives.
- [web-trace-react AGENTS.md](../../web-trace/web-trace-react/AGENTS.md) — the
  paged-read and router-seam patterns this package clones.
- [emr AGENTS.md](../../emr/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
