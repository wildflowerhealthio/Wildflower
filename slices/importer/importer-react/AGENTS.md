# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice, and its **shell**: the whole
pick-review-confirm flow, plus the React half of the closed format registry.
One surface a host app mounts, reading the authed runner out of router context:

- **`ImporterScreen`** — pick one or more files (local files dropped or
  chosen, or a single source file already on the device's FHIR server), review
  exactly what every format would write in one combined, **generalized**
  view — each format's decoded sections with per-resource include/edit, under
  its own settings form — confirm once to write the reviewed, included
  resources across the batch (every file's source file among them), and read
  the per-format results. Local picking is a **batch**; the server list is
  single-select.

The whole read half — grouping a pick by format, running each format's
`decode`, re-decoding under new settings, and planning a format's write — is
`importer-core`'s, and pure. This package is the React state, the views, and
the two authed actions around it.

The anonymize surface is the anonymizer slice's shell
([anonymizer-react](../../anonymizer/anonymizer-react/AGENTS.md)), not part of
this package. This package exports `ServerSourceFileList` — the
uploaded-source-files pick source, spanning every registered format's source
files (HAR, LifeLabs PDF, DICOM) — which a host passes into that shell's
`serverSource` slot.

## Layering

`importer-react` is an adapter and follows the rule in
[slices/AGENTS.md](../../AGENTS.md): it depends on its sources, never the reverse.
It depends on `importer-core` (the importer registry, `readBatch` /
`redecodeFormat` / `claimedFormats` / `planFormatWrite`, and the
`BatchDecodeResult` model), `importer-fundamentals` (the `PickedFile`
vocabulary, the `FormatDecode.Result` and `DecodedFile` shapes, and the pure
`StagedImport` model), each format's
React package for its settings picker only (`har-importer-react`,
`lifelabs-pdf-importer-react`, `dicom-importer-react`), `fhir-r4` (the typed
client, `persistBatchBundle`, and the server-diff classifier), `fhir-r4-react`
(the authed runner and the slice runtime layer), and `react-tundraish`. It
names no format's core package and no `web-trace-core` at runtime — HAR
fixtures in `importer-screen.test.tsx` are the only place `http-archive` and
`web-trace-core` appear at all.

The seam between this package and a format is its **`FileImporter`** (reached
through `importer-core`'s registry) and the `StagedImport` model: the read half
runs `readBatch` (no writes) into one result per format — sections + notes —
the review drives `StagedImport`'s pure per-resource transitions over the
flattened sections, and the write half runs `planFormatWrite`'s resources
through the shared `persistBatchBundle`. If a component needs more than those expose, widen them
rather than reaching around them.

**Presentation and interaction only.** Nothing here parses a file, mints or
encodes a source file, runs entities, or writes resources. The parsers, the
source-file mint, `decode` (including each format's recognition),
and the batch machinery all live below this package; it drives them and
reimplements none.

## The registry

`src/registry.ts` is `importer-core`'s closed `format → FileImporter` registry
with the one React part a format contributes — its `SettingsPicker` — attached
to each entry by `withSettingsPicker`, a **spread**, not a subclass: a
`FileImporter` is a plain record with no prototype, so the spread is total and
a field added to it cannot be silently dropped on the way through. The importer
half is registered in `importer-core/src/registry.ts`; this file is the single
edit point for a format's UI. `BoundFormat<K>` keeps per-format concrete types
against `FormatSettings[K]`, so a picker typed against another format's
settings fails to compile here. `har`, `lifelabs-pdf`, and `dicom` are
registered. `defaultFormatSettings` (the `FormatSettings` record a fresh import
seeds) and `formatKinds` (the typed registry-order walk) are re-exported from
the core registry unchanged. There is no format-specific review UI slot: the
`PreviewPanel` renders every format the same way, from its decoded sections.
The importer has no HTTP wire union to derive, so there is no separate
`importer-registry` package the collector slice needs.

## Module layout

- **`src/importer-screen.tsx`** — the flow, top to bottom. Reads everything from
  router context (no props): `SourcePicker` → `useImportRun` → `PreviewPanel` →
  `useConfirmImport` → `ImportResults`. It holds each format's
  `StagedImport.Selection`, keyed by format kind (absent = the server-diff
  seed, every `new` or `changed` resource included, so an untouched format
  still imports everything its decode yielded). A cancel or "import
  another" discards the read, every review edit, and any confirm outcome, and
  returns to the picker; the per-format settings persist across it.
- **`src/registry.ts`** — the React half of the closed format registry (above).
- **`src/preview/`** — the read half's React state, the review view, and the
  write action.
  `use-import-run.ts` is React state around `importer-core`: `run` calls
  `readBatch` (through `useRunAuthed`) over the whole pick and holds the
  resulting `BatchDecodeResult`, `applySettings` calls `redecodeFormat` for the
  one format whose settings changed — from that format's retained
  `PickedFile`s, keeping every id and review key, so keyed selections keep
  applying — and it owns the `FormatSettings` record, the `batchId` that tells
  a fresh pick from a re-decode, and the in-flight ticket that drops a stale
  result. It imports the registry rather than taking it as a parameter, so its
  dependency arrays say what they mean. Grouping, decoding, and folding
  outcomes all happen in the core.
  `use-server-diff.ts` pre-classifies every previewed resource against the
  server (`new` / `unchanged` / `changed`) for the row badges and the "already
  there, so pre-excluded" seed, keyed **by format kind and then by resource
  key** (`FormatComparisons`) — two formats can carry the same resource key, so
  a flat map would let one format's verdict overwrite another's. Within one
  format the keys are already distinct, because `fileImporter` namespaces each
  claimed file's keys by its slot in the batch. The screen blocks the
  first paint on it but **not** on the re-classification a settings change
  triggers, since unmounting the panel mid-review would drop the focus of
  whatever settings control the reviewer is using.
  `preview-panel.tsx` renders the batch grouped by format — one group per
  `claimedFormats` entry, its settings form (the registry's own
  `SettingsPicker`, indexed by the format tag) over that format's sectioned,
  per-resource review — under one shared confirm, gated on the batch having at
  least one **included** resource. It is the panel, the actions and the editor
  dialog only; the review body it renders per format is
  `read-file-body.tsx` (per-type tallies, one titled section per decoded
  section with include checkbox and one-line `describeResource` summary,
  Edit/Revert, unreadable-file rows, and the notes folded into a collapsed
  details block), the server-diff badge and its field-level disclosure are
  `diff-badge.tsx`, and every user-visible string is `preview-text.ts`.
  `use-confirm-import.ts` is the opt-in write action, per **claimed** format,
  best-effort: `planFormatWrite` (in `importer-core`) then one
  `persistBatchBundle` of exactly those resources. It adds nothing to any
  resource — no id locking, no provenance stamping — because the format's
  `decode` already minted the source file and stamped every extracted
  resource's `meta.source`. One format's failure never stops the rest, and a
  rejected source file is just one failed entry; there is no separate upload
  step to fail.
  `resource-editor.tsx` (+ `resource-editor-helpers.ts`) is the inline JSON
  editor: **Keep** parses the text, decodes through
  `Schema.decodeUnknown(FhirResourceSchema)`, and refuses the edit unless it
  parses and preserves `resourceType` / `id`; `describe-resource.ts` is the
  pure one-line summary per resource type. Both moved here from
  `har-importer-react` when the review display was generalized.
- **`src/results/`** — the outcome. `import-outcome.ts` is the pure fold: the
  per-format `ImportOutcome` and the `FileImportResult`/`BatchOutcome`
  aggregate (`summarizeBatch`, `isPartialBatch`), every row carrying the
  format result's `title` (its claimed file names) rather than a file name of
  its own, all on `collectImportSummary` semantics (any failure ⇒ partial);
  `import-results.tsx` renders the batch grouped by response code — every
  submitted resource (the source file included) with its status, plus the
  formats that had nothing to import — under one aggregate tally. Only claimed
  formats appear: a format that took no files is not a "nothing to import"
  row. There is no
  upload-failed section: a rejected source file is an ordinary failure row.
- **`src/sources/`** — the picker. `picked-file.ts` is a re-export shim of
  `importer-fundamentals`' vocabulary (`PickedFile` — `{ fileName, bytes,
source }` — the `local` / `server` `PickedFileSource.Source`, `LOCAL_SOURCE`,
  `serverSource`, and `sourceFileReference`); nothing here redefines it, since
  every format's `decode` reads the same type. `local-file.ts` is the
  format-blind "read a local file's bytes and identify it against the
  registered formats' `detect`" gate — no format's `decode` runs at
  pick time; `server-source-file-list.tsx` is the uploaded-source-files pick
  source (rows, paging, per-row explicit **Preview** + **Use as source**
  buttons, the raw-contents modal each Preview opens), spanning every
  registered format via its importer's server-read seam, and exported for the
  anonymizer shell's `serverSource` slot as much as used here;
  `source-picker.tsx` composes the drop-and-pick zone, the file input it opens,
  and that server list. Two modes: `'batch'` (default; the importer flow)
  accepts several files in one pick; `'single'` trims the accepted list to the
  first file and drops the OS dialog's `multiple` attribute — the server list
  is single-select in both.
- **`src/queries/`** — the reads. `source-files.ts` is the paged, format-blind
  `DocumentReference` search: one request per page with `category` set to
  the comma-joined `system|code` tokens of every registered format
  (`SOURCE_FILES_CATEGORY_TOKEN`), each returned resource classified by
  dispatching every format's `isSourceFile` predicate in registry order
  (disjoint by construction) so rows are tagged with the format they
  came from; plus `fetchSourceFile` — the row-select's fetch-and-decode
  through the row's format's `sourceFileFromDocumentReference` — and
  `fetchSourceFileContents`, the read-only variant the preview modal uses.
  `page-token.ts` pulls the continuation cursor out of a bundle's `next`
  link (a copy of the web-trace viewer's, see the trap); `keys.ts` holds
  the query-key roots.
- **The source file is a reviewed resource the format minted.** A `local`
  pick's source-file `DocumentReference` is minted inside that format's
  `decode` (by the batch decode `fileImporter` built) and arrives as its own
  "Source file" section ahead of that file's extracted ones, keyed
  `<slot>/source-file/<fileName>`. The shell neither mints it nor
  keys it, and dispatches on no format tag to get it: it reviews the row like
  any other resource, so the reviewer can edit its JSON or skip it. A settings
  re-decode re-mints it at the same deterministic id, so the review key and the
  `meta.source` links survive. The source-file list query is invalidated once at
  end-of-batch (a fresh source file is a new `DocumentReference` the picker
  should see next pick — cheap even when none wrote).

## Traps

- **The read half writes nothing, and the split is the whole product.** Reaching
  a review issues no writes — `decode` requires no services and is run for its
  data only, and the confirm writes exactly the reviewed objects
  (`planFormatWrite` over the format's decoded sections) with no
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
  via `onSelectionChange`, holding the canonical
  `Map<FormatKind, Selection>` so it can hand the confirm the exact selection
  each format was reviewed with (`planFormatWrite` over that format's own
  decoded sections). Same for
  settings: the panel renders `settings` and reports `onSettingsChange`;
  `useImportRun` owns the record and the re-decode. Don't move either down
  into the panel, or the shell and the view can disagree.
- **A format's confirm is one `persistBatchBundle`, and nothing is stamped at
  confirm.** `planFormatWrite` (in `importer-core`) turns the format's decoded
  sections plus the reviewer's selection into the exact resource list — a
  `local` pick's set leads with its source file in the same bundle as its
  extracted resources, no upload-then-persist sequence and no ordering to
  protect. `importOneFormat` hands that list straight to
  `persistBatchBundle`: it does not look for the
  source file, lock an id, or write `meta.source`, because the format's
  `decode` already minted the source file at a deterministic id and stamped
  every extracted resource with its reference. A source-file row the reviewer
  **excluded** is simply not written, and the resources keep their
  `meta.source` — the link points at a `DocumentReference` this batch chose not
  to upload, which is the reviewer's decision, not a rewrite the shell makes.
  The batch is one Effect (`Effect.forEach` at unbounded concurrency) run
  through `runAuthed`; cross-format interleaving is fine because each resource
  carries its own file's reference. `useConfirmImport` needs nothing from the
  registry — persistence is format-blind.
- **The batch is best-effort, and there is no upload-failed case.**
  `persistBatchBundle`'s error channel is `never`, so a rejected resource —
  the source file included — is a per-entry outcome, not a raised error; one
  format's failures never stop the rest. A claimed format whose review chose
  nothing (no kind recognized it, or every matching kind toggled off) or whose
  every file was unreadable is `skipped`, never a failure. `isPartialBatch`
  lifts `collectImportSummary` to the batch: any rejected resource makes it
  partial; a `skipped` format alone does not. There is **no** whole-flow `errored` state and no `uploadFailed` result —
  a failed source file is an ordinary row in the results, its cause the server's own
  response. Note the trade-off the fold-in accepts: if the source file is included
  but its write fails while the resources succeed, those resources carry a
  `meta.source` pointing at a source file that is not there — FHIR batch entries
  are independent, so there is no way to gate them on the source file within one
  bundle. The failed source file row makes this visible rather than silent.
- **The confirm affordance is gated on the batch having an included resource to
  write.** `PreviewPanel` shows the single confirm button only when
  `StagedImport.includedCount` summed across the **claimed** formats is
  positive; unreadable files and formats whose decode yielded nothing render
  their own section but add nothing to write. Both that sum and the group list
  come off `claimedFormats`, the one predicate for "did this format take part",
  which the confirm reads too — a format that claimed nothing is not planned,
  tallied, or reported. `useConfirmImport` re-checks each claimed format
  (skipping the ones with nothing included) — the gate is the affordance, the
  per-format check is the safety.
- **The source file list is format-blind and disjoint from web traces on the
  same axis.** The list searches `category` for `SOURCE_FILES_CATEGORY_TOKEN` —
  the comma-joined `system|code` tokens of every registered format's
  source file coding (`WEB_TRACE_CODE_SYSTEM|har-archive` for HAR, the LifeLabs and DICOM
  systems for theirs), built at module
  load from each format's `categoryToken` so it cannot drift from what the
  mint writes. Each returned resource is classified in
  registry order through each format's `isSourceFile`; the predicates
  are disjoint by construction (each tests a different `system|code`),
  so at most one claims any row and a row no predicate claims is
  dropped. The web-trace viewer lists traces under a different category
  code on the same system; `isWebTrace` and any format's `isSourceFile`
  never both hold. The list must never surface a trace, and the trace
  viewer must never surface a source file.
- **The picker identifies each local file syntactically through the
  registered formats' `detect`, not a full parse.** `acceptLocalFile`
  runs `importer-fundamentals`' `identify` over the registered importers,
  so every format's `detect` runs on every drop — cheap on purpose — and a
  file no format claims is rejected _at the picker_, next to the control
  the user just used. In a batch the accepted files are handed on together
  and the rejected ones are named in the notice; a **lone** rejected file
  with nothing accepted keeps its own rejection message. The full parse
  still runs in that format's `decode` one step downstream, so a file the
  picker accepted whose bytes are malformed lands in the preview as its own
  unreadable row rather than a batch-wide error.
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
- **A row selection decodes through its format's source-file reader and keeps
  the bytes verbatim.** `fetchSourceFile` dispatches to the row's format's
  `sourceFileFromDocumentReference` (the importer's server-read seam) — a
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
  synthesis) and picks its renderer from the format's `contentType`: PDF via
  a `<iframe>` at a `blob:` URL over the
  bytes (revoked on unmount), JSON pretty-printed inside a `<pre>`
  capped at `JSON_PREVIEW_SIZE_LIMIT` (5 MiB) with a "Download raw"
  fallback for a giant source file. The modal writes nothing and offers no
  editing — a preview is inspection, not another entry point to the
  review flow.
- **A source file's id is derived from its bytes and name, so re-importing upserts.**
  The mint `fileImporter` derives, which each format's `decode` drives,
  derives the resource id with `localResourceId` over the file's SHA-256 and
  name — deterministic, not a per-pick uuid — so its bundle entry is a PUT to a
  stable `DocumentReference/<id>` and re-importing the same file under the same
  name overwrites in place rather than piling up duplicates. The attachment's
  `hash` and `size` still describe the bytes. (Result ids are also
  deterministic — `FormatDecode.makeId` over the format tag and each picked
  file's slot — so there is no client-side `crypto.randomUUID()` anywhere in
  the flow.)
- **Upload takes bytes, not text.** The source-file mint stores the file
  verbatim so a truncated or mis-encoded upload is preserved and the
  attachment `hash` means something. `PickedFile.bytes` is a `Uint8Array` from
  the picker all the way to the mint, and nothing in between re-encodes it.
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
  the confirm (the source file and the extracted resources go out in one
  bundle, every resource write carrying the `meta.source` its decode stamped),
  the server-source case, the
  multi-file batch, the per-file source-file failure, the partial-write fold,
  that a single-format import reports no blank "nothing to import" rows, and
  cancel. It re-wraps `TextEncoder` output through the ambient `Uint8Array` (a
  jsdom single-realm workaround; the production encode stays `new
TextEncoder().encode(text)`).
- `preview/preview-panel.test.tsx` drives the pure panel by props — no router —
  and pins that a claimed format renders each decoded section under its own
  title with per-resource checkboxes, that an unreadable file renders its own
  alert, that a mixed batch sums to one confirm over every claimed format's
  sections, that each registered format mounts its own settings picker, and
  that the confirm appears only when at least one resource is included.
  `results/import-outcome.test.ts` is the property/example test for the folds.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles,
  guardrails, and the per-URL pick-review-confirm pipeline this package's flow
  drives.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract and the `StagedImport` model this shell drives.
- [importer-core AGENTS.md](../importer-core/AGENTS.md) — the importer
  registry and the batch machinery these hooks wrap.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR
  importer (`decode` plus the server-read seam) the core registry lists.
- [har-importer-react AGENTS.md](../har-importer-react/AGENTS.md) — the
  `HarSettingsPicker` this shell mounts per HAR group.
- [slices AGENTS.md](../../AGENTS.md) — the slice layering rules this package
  follows.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the
  coding a HAR source file shares an axis with, and the disjointness of traces
  and source files (a test-fixture dependency here, nothing at runtime).
- [web-trace-react AGENTS.md](../../web-trace/web-trace-react/AGENTS.md) — the
  paged-read and router-seam patterns this package clones.
- [emr AGENTS.md](../../emr/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
