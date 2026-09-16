# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice, and its **shell**: the whole
pick-review-confirm flow plus the closed `format → { descriptor,
SettingsPicker }` registry. One surface a host app mounts, reading the authed
runner out of router context:

- **`ImporterScreen`** — pick one or more files (local files dropped or
  chosen, or a single HAR source file already on the device's FHIR server),
  review exactly what every file would write in one combined, **generalized**
  view — each file's decoded sections with per-resource include/edit, under
  its format's settings form — confirm once to write the reviewed, included
  resources across the batch (uploading each local file's source file first), and
  read the per-file results. Local picking is a **batch**; the server list is
  single-select.

The anonymize surface is the anonymizer slice's shell
([anonymizer-react](../../anonymizer/anonymizer-react/AGENTS.md)), not part of
this package. This package exports `ServerSourceFileList` — the
uploaded-source-files pick source, spanning every registered format's source files
(HAR, LifeLabs PDF) — which a host passes into that shell's `serverSource`
slot.

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
writes) into sections + notes, the review drives `Review`'s pure per-resource
transitions over the flattened sections, and the write half runs
`Review.chosenResources` through the shell's shared `persistBatchBundle`. If a component needs
more than the descriptor and `Review` expose, widen those rather than reaching
around them.

**Presentation and interaction only.** Nothing here parses HAR, encodes a
source file, runs entities, or writes resources. The parsers, the source file codecs,
`decode` (including each format's recognition), and the write sink (`persist` →
`fhir-r4`'s `persistResources`) all live below this package; it drives them and
reimplements none.

## The registry

`src/registry.ts` is the closed, compile-time `format → BoundFormat<K>` map —
the single edit point for wiring a file-format importer into the shell. A
`BoundFormat` bundles the descriptor's fields (typed per format through the
`FormatVariant` type-level map, so per-format concrete types survive without
casts) plus the one React part a format contributes: its `SettingsPicker`. A
format missing a part fails to compile here. `har` and `lifelabs-pdf` are
registered. `defaultFormatSettings` collects every format's `defaultSettings`
into the `FormatSettings` record the shell holds, and `formatKinds` is the
typed registry-order walk. There is no format-specific review UI slot: the
`PreviewPanel` renders every format the same way, from its decoded sections.
The importer has no HTTP wire union to derive, so there is no separate
`importer-registry` package the collector slice needs.

## Module layout

- **`src/importer-screen.tsx`** — the flow, top to bottom. Reads everything from
  router context (no props): `SourcePicker` → `useImportRun` → `PreviewPanel` →
  `useConfirmImport` → `ImportResults`. It holds each read file's
  `Review.Selection`, keyed by the file's stable id (absent = the default,
  every resource included, so an untouched file still imports everything its
  decode yielded). A cancel or "import another" discards the read, every
  review edit, and any confirm outcome, and returns to the picker; the
  per-format settings persist across it.
- **`src/registry.ts`** — the closed format registry (above).
- **`src/preview/`** — the read half, the review view, and the write action.
  `use-import-run.ts` runs the descriptor's `decode` (via `useRunAuthed`) once
  per picked file under that format's current settings, holds the batch of
  `FileReadOutcome`s (each a `read` — its `DecodedFile` of sections + notes —
  an `unreadable`, or an `unrecognized` file), owns the `FormatSettings`
  record, and re-decodes a format's files from their retained bytes when
  `applySettings` changes that format's settings (file ids survive, so keyed
  selections keep applying); `use-server-diff.ts` pre-classifies every
  previewed resource against the server (`new` / `unchanged` / `changed`) for
  the row badges and the "already there, so pre-excluded" seed — the screen
  blocks the first paint on it (`firstLoad`) but **not** on the
  re-classification a settings change triggers, since unmounting the panel
  mid-review would drop the focus of whatever settings control the reviewer is
  using; `preview-panel.tsx` renders the batch grouped by
  format — the format's settings form (dispatched `Match.exhaustive` on the
  format tag, so registering a format without a branch fails to compile rather
  than silently binding its group to a sibling's picker) over each of its
  files' sectioned,
  per-resource reviews (include checkbox, one-line `describeResource`
  summary, Edit/Revert with the `ResourceEditor` dialog, per-type tallies,
  and the file's notes folded into a collapsed details block) — under one
  shared confirm, gated on the batch having at least one **included**
  resource; `use-confirm-import.ts` is the opt-in write action, per file,
  best-effort — one `persistBatchBundle` of each file's `Review.chosenResources`
  (its source file among them, when the reviewer kept it), each
  extracted resource stamped with the source file's reference and the source file's own
  id locked so an edit can't drift the link; a skipped source file leaves the
  resources unstamped. One file's failure never stops the rest, and a rejected
  source file is just one failed entry — there is no separate upload step to fail.
  `resource-editor.tsx` (+
  `resource-editor-helpers.ts`) is the inline JSON editor: **Keep** parses
  the text, decodes through `Schema.decodeUnknown(FhirResourceSchema)`, and
  refuses the edit unless it parses and preserves `resourceType` / `id`;
  `describe-resource.ts` is the pure one-line summary per resource type.
  Both moved here from `har-importer-react` when the review display was
  generalized.
- **`src/results/`** — the outcome. `import-outcome.ts` is the pure fold: the
  per-file `ImportOutcome` and the `FileImportResult`/`BatchOutcome` aggregate
  (`summarizeBatch`, `isPartialBatch`), all on `collectImportSummary` semantics
  (any failure ⇒ partial); `import-results.tsx` renders the batch grouped by
  response code — every submitted resource (the source file included)
  with its status, plus the files that had nothing to import — under one
  aggregate tally. There is no upload-failed section: a rejected source file is an
  ordinary failure row.
- **`src/sources/`** — the picker. `picked-file.ts` is the vocabulary
  (`PickedFile` — `{ fileName, bytes, source }` — the `local` / `server`
  `PickedFileSource`, and `sourceFileReference` — the one spelling of a
  `DocumentReference/<id>` reference, format-blind); `local-file.ts` is
  the format-blind "read a local file's bytes and identify it against
  the registered descriptors' `detect`" gate — no descriptor's `decode`
  runs at pick time; `server-source-file-list.tsx` is the uploaded-source-files
  pick source (rows, paging, per-row explicit **Preview** + **Use as
  source** buttons, the raw-contents modal each Preview opens), spanning
  every registered format via the descriptor source file seam, and exported
  for the anonymizer shell's `serverSource` slot as much as used here;
  `source-picker.tsx` composes the drop-and-pick zone, the file input it
  opens, and that server list. Two modes: `'batch'` (default; the importer
  flow) accepts several files in one pick; `'single'` trims the accepted
  list to the first file and drops the OS dialog's `multiple` attribute —
  the server list is single-select in both.
- **`src/queries/`** — the reads. `source-files.ts` is the paged, format-blind
  `DocumentReference` search: one request per page with `category` set to
  the comma-joined `system|code` tokens of every registered format
  (`SOURCE_FILES_CATEGORY_TOKEN`), each returned resource classified by
  dispatching every descriptor's `isSourceFile` predicate in registry order
  (disjoint by construction) so rows are tagged with the format they
  came from; plus `fetchSourceFile` — the row-select's fetch-and-decode
  through the row's format's `sourceFileFromDocumentReference` — and
  `fetchSourceFileContents`, the read-only variant the preview modal uses.
  `page-token.ts` pulls the continuation cursor out of a bundle's `next`
  link (a copy of the web-trace viewer's, see the trap); `keys.ts` holds
  the query-key roots.
- **The source file is a reviewed resource, built at read time.**
  `useImportRun` mints a `local` pick's source file `DocumentReference` once
  (`descriptor.buildSourceFile`, `Match.type<FormatKind>()`-dispatched) and
  injects it as its own "Source file" `LabeledSection` (stable key
  `source-file`) ahead of the extracted sections, so the reviewer can rename
  its JSON or skip it like any resource; a settings re-decode reuses the same
  source file rather than minting a fresh one, so its id and the reviewer's edit
  stay put. The source file list query is invalidated once at end-of-batch (a fresh
  source file is a new `DocumentReference` the picker should see next pick — cheap
  even when none wrote).

## Traps

- **The read half writes nothing, and the split is the whole product.** Reaching
  a review issues no writes — `decode` requires no services and is run for its
  data only, and the confirm writes exactly the reviewed objects
  (`Review.chosenResources` over the file's decoded sections) with no
  re-parse. A test pins this on the wire (zero writes to reach a review); do
  not add a write to the read path (e.g. an "auto-upload on pick") that would
  collapse the opt-in seam. A settings change re-runs `decode` — still the
  read half, still no writes.
- **`ServerSourceFileList` never writes.** The list is a search, a selection is
  a `DocumentReference` GET, and a preview is the same GET plus a bytes
  render. It is exported into the anonymizer shell's `serverSource` slot
  precisely because it is read-only; do not add a write to it — the preview
  modal is deliberately not editable, either.
- **Selection state lives in the screen, not the panel.** `PreviewPanel` is
  controlled — the screen passes `selectionFor` in and receives every change
  via `onSelectionChange`, holding the canonical `Map<fileId, Selection>` so
  it can hand the confirm the exact selection each file was reviewed with
  (`Review.chosenResources` over the file's own decoded sections). Same for
  settings: the panel renders `settings` and reports `onSettingsChange`;
  `useImportRun` owns the record and the re-decode. Don't move either down
  into the panel, or the shell and the view can disagree.
- **A file's confirm is one `persistBatchBundle`, source file included.** Since the
  source file is one of the reviewed resources, a `local` pick's write set is
  `[sourceFile, ...extracted]` in one bundle — no upload-then-persist sequence, no
  ordering to protect. `importOneFile` finds the source file in the chosen set by
  its stable review key (not by re-recognizing its coding, so an inline edit
  can't change how it is treated), locks its id to the minted value, and stamps
  every _other_ chosen resource's `meta.source` with the source file reference.
  `sourceRef` is: a `server` pick's existing reference; the local source file's
  reference when it is kept; or **absent** when the reviewer skipped it, in
  which case the extracted resources are written **without** `meta.source`. The
  batch is one Effect (`Effect.forEach` at unbounded concurrency) run through
  `runAuthed`; cross-file interleaving is fine because each resource is stamped
  with its own file's reference. `useConfirmImport` needs nothing from the
  registry — persistence and stamping are format-blind.
- **The batch is best-effort, and there is no upload-failed case.**
  `persistBatchBundle`'s error channel is `never`, so a rejected resource —
  the source file included — is a per-entry outcome, not a raised error; one file's
  failures never stop the rest. A file whose review chose nothing (no kind
  recognized it, or every matching kind toggled off) or that was `unreadable` is
  `skipped`, never a failure. `isPartialBatch` lifts `collectImportSummary` to
  the batch: any rejected resource makes it partial; a `skipped` file alone does
  not. There is **no** whole-flow `errored` state and no `uploadFailed` result —
  a failed source file is an ordinary row in the results, its cause the server's own
  response. Note the trade-off the fold-in accepts: if the source file is included
  but its write fails while the resources succeed, those resources carry a
  `meta.source` pointing at a source file that is not there — FHIR batch entries
  are independent, so there is no way to gate them on the source file within one
  bundle. The failed source file row makes this visible rather than silent.
- **The confirm affordance is gated on the batch having an included resource to
  write.** `PreviewPanel` shows the single confirm button only when
  `Review.includedCount` summed across the read files is positive; unreadable
  files and read files whose decode yielded nothing render their own section
  but add nothing to write. `useConfirmImport` re-checks each file (skipping
  the ones with nothing included) — the gate is the affordance, the per-file
  check is the safety.
- **The source file list is format-blind and disjoint from web traces on the
  same axis.** The list searches `category` for `SOURCE_FILES_CATEGORY_TOKEN` —
  the comma-joined `system|code` tokens of every registered format's
  source file coding (`WEB_TRACE_CODE_SYSTEM|har-archive` for HAR,
  `LIFELABS_SYSTEM|lifelabs-pdf-archive` for LifeLabs), built at module
  load from each descriptor's `sourceFileCategoryToken` so it cannot drift
  from what the codec writes. Each returned resource is classified in
  registry order through each descriptor's `isSourceFile`; the predicates
  are disjoint by construction (each tests a different `system|code`),
  so at most one claims any row and a row no predicate claims is
  dropped. The web-trace viewer lists traces under a different category
  code on the same system; `isWebTrace` and any format's `isSourceFile`
  never both hold. The list must never surface a trace, and the trace
  viewer must never surface a source file.
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
- **The list carries rows, not source files.** A source file's bytes are the whole
  file, potentially megabytes (a multi-MB HAR, a PDF); `SourceFileRow` holds
  only the id, its classified format, the title, and the upload instant.
  `fetchSourceFile` (row select) and `fetchSourceFileContents` (preview modal)
  each read the one source file the user chose. Listing the bytes to render a
  title would pull every source file onto the device to draw a list.
- **A row selection decodes through its format's source file codec and keeps
  the bytes verbatim.** `fetchSourceFile` dispatches to the row's format's
  `sourceFileFromDocumentReference` (per the descriptor source file seam) — a
  resource that is not a source file of that format fails as a `ParseError`,
  never yields nonsense — and returns the source file's `bytes` on the
  `PickedFile`. Every downstream step reads bytes (`decode`, and the
  confirm's upload if the pick were local). The `server` source carries
  `DocumentReference/<id>` (via `sourceFileReference`, format-blind) so a
  later step links provenance to the stored source file rather than
  re-uploading.
- **A row's Preview action opens a read-only raw-contents modal that
  renders the file itself.** The modal fetches through
  `fetchSourceFileContents` (the same reader as a pick, minus the source
  synthesis) and picks its renderer from the format's
  `sourceFileContentType`: PDF via a `<iframe>` at a `blob:` URL over the
  bytes (revoked on unmount), JSON pretty-printed inside a `<pre>`
  capped at `JSON_PREVIEW_SIZE_LIMIT` (5 MiB) with a "Download raw"
  fallback for a giant source file. The modal writes nothing and offers no
  editing — a preview is inspection, not another entry point to the
  review flow.
- **A source file's id is derived from its bytes and name, so re-importing upserts.**
  Each format's `buildSourceFile` (the shared `sourceFileCodec.buildSourceFile`)
  derives the resource id with `localResourceId` over the file's SHA-256 and
  name — deterministic, not a per-pick uuid — so its bundle entry is a PUT to a
  stable `DocumentReference/<id>` and re-importing the same file under the same
  name overwrites in place rather than piling up duplicates. The attachment's
  `hash` and `size` still describe the bytes. (The per-pick `crypto.randomUUID()`
  in `use-import-run.ts` is the client-side batch/run id for a file, not the
  source file resource id.)
- **Upload takes bytes, not text.** The source file codec stores the file
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
- **The authed runner comes from router context, one way.** `useSourceFilesQuery`,
  the picker's row-select, and the preview modal's fetch all read
  `useRunAuthed()`; the query also exposes
  `sourceFilesInfiniteQueryOptions(runAuthed, options)` taking the runner as
  its first argument, for a loader or a test that drives the query itself.
  There is no prop-threaded second way in — this mirrors `web-trace-react`.

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
  the server source file fixtures are hand-built `DocumentReference` JSON with base64
  `data` so a `Uint8Array` from jsdom's realm never has to satisfy the codec's
  `instanceof` check.
- `importer-screen.test.tsx` is the end-to-end one: it replaces only the router
  seam and drives the whole flow over a recording stub `HttpClient`, reading one
  ordered write log back. It pins the opt-in seam (zero writes to reach a review),
  the confirm ordering (the source file create lands before the first resource write,
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
  traces and source files.
- [web-trace-react AGENTS.md](../../web-trace/web-trace-react/AGENTS.md) — the
  paged-read and router-seam patterns this package clones.
- [emr AGENTS.md](../../emr/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
