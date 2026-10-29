# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice, and its **shell**: the whole
pick-review-confirm flow, plus the React half of the closed format registry.
One surface a host app mounts, reading the authed runner out of router context:

- **`ImporterScreen`** — pick one or more files (local files dropped or
  chosen, or source files already on the device's FHIR server), review
  exactly what every format would write in one combined, **generalized**
  view — each format's decoded sections with per-resource include/edit, under
  its own settings form — confirm once to write the reviewed, included
  resources across the batch (every file's source file among them), and read
  the per-format results. Every source picks a **batch**: several local files,
  several folder entries, several server rows.

The whole read half — grouping a pick by format, running each format's
`decode`, re-decoding under new settings, and planning a format's write — is
`importer-core`'s, and pure. This package is the React state, the views, and
the two authed actions around it.

The anonymize surface is the anonymizer's shell
([anonymizer-react](../../anonymizer/anonymizer-react/AGENTS.md)), not part of
this package. This package exports `ServerSourceFileList` — the
uploaded-source-files pick source, spanning every registered format's source
files (HAR, LifeLabs PDF, DICOM) — which a host passes into that shell's
`serverSource` slot. It also exports `ImporterWalkthroughAnchor`, the
`data-walkthrough` values (`walkthrough-core`'s `walkthroughAnchor`) on the
source picker's controls, which a host's first-run walkthrough points at; the
walkthrough itself is the host's.

## Layering

`importer-react` is an adapter and follows the rule in
[slices/AGENTS.md](../../../slices/AGENTS.md): it depends on its sources, never the reverse.
It depends on `importer-core` (the importer registry, `readBatch` /
`redecodeFormat` / `claimedFormats` / `planWrite`, and the
`DecodedBatch` model), `importer-fundamentals` (the `PickedFile`
vocabulary, the `FormatDecode.Result` and `DecodedFile` shapes, and the pure
`StagedImport` model), each format's
React package for its settings picker only (`har-importer-react`,
`lifelabs-pdf-importer-react`, `dicom-importer-react`), `fhir-r4` (the typed
client, `persistTransactionBundle`, and the server-diff classifier), `fhir-r4-react`
(the authed runner and the slice runtime layer), and `react-tundraish`. It
names no format's core package and no `web-trace-core` at runtime — HAR
fixtures in `importer-screen.test.tsx` are the only place `http-archive` and
`web-trace-core` appear at all.

The seam between this package and a format is its **`FileImporter`** (reached
through `importer-core`'s registry) and the `StagedImport` model: the read half
runs `readBatch` (no writes) into one result per format — sections + notes —
the review drives `StagedImport`'s pure per-resource transitions over the
flattened sections, and the write half runs the resources `planWrite`
includes, the batch's linked records among them, through one
`persistTransactionBundle`. If a component needs more than those expose, widen them
rather than reaching around them.

**Presentation and interaction only.** Nothing here parses a file, mints or
encodes a source file, runs entities, or writes resources. The parsers, the
source-file mint, `decode` (including each format's recognition),
and the batch machinery all live below this package; it drives them and
reimplements none.

## The registry

`src/registry.ts` is `importer-core`'s closed `format → FileImporter` registry
with the React parts a format contributes — its `SettingsPicker`, and an
optional `FilePreview` the server source file list's preview dialog renders in
place of its content-type dispatch — attached to each entry by `withComponents`, a
**spread**, not a subclass: a
`FileImporter` is a plain record with no prototype, so the spread is total and
a field added to it cannot be silently dropped on the way through. The importer
half is registered in `importer-core/src/registry.ts`; this file is the single
edit point for a format's UI. **`FormatWithComponents<K>`** — named for what it
adds, and defined as `importer-core`'s `BoundFormat<K>` intersected with the
picker rather than restating it — keeps per-format concrete types against
`FormatSettings[K]`, so a picker typed against another format's settings fails
to compile here. A `FilePreview`'s props are `PickedFile.NamedBytes` rather
than a props type of their own: a preview is handed a file's name and bytes,
which is exactly that shape, and a second interface saying so would only be a
structural copy that could drift. `har`, `lifelabs-pdf`, and `dicom` are
registered; `dicom` is the only one with a `FilePreview` today.
This module exports **only what it adds**: `defaultFormatSettings`,
`formatKinds`, `FormatKind` and `FormatSettings` are `importer-core`'s and are
imported from there directly, since re-exporting them here gave the package two
routes to the same symbol and it used both. There is no format-specific review UI slot: the
`PreviewPanel` renders every format the same way, from its decoded sections.
The importer has no HTTP wire union to derive, so there is no separate
`importer-registry` package.

## Module layout

- **`src/importer-screen.tsx`** — the flow, top to bottom. Reads everything from
  router context (no props): `SourcePicker` → `useImportRun` → `PreviewPanel` →
  `useConfirmImport` → `ImportResults`. It holds each format's
  `StagedImport.Selection`, keyed by format kind (absent = the seed: every
  `new` or `changed` resource included, every `unchanged` one and every one
  whose patient the referent links leave unlinked, as decoded, left out
  (`initialFormatExclusionsFor` over `initialExclusionsFor`), so an untouched format imports what its decode
  yielded that is new and has a patient). A referent's link change reverts
  the edit override at that referent's `reviewKey` in every format, since its
  row now writes another record. A cancel or "import
  another" discards the read, every review edit, and any confirm outcome, and
  returns to the picker; the per-format settings persist across it.
- **`src/registry.ts`** — the React half of the closed format registry (above).
- **`src/identity/`** — the identity map in the screen.
  The review of a batch is one hook composed of three, each in its own file:
  - `use-link-choice-review.ts` — `useLinkChoiceReview`
    discovers the batch's referents (`discoverReferents`) and memoizes the
    **resolved** batch (one whose mentions are resolved) with each
    the plan it was resolved on (`ResolvedBatch.plan`), which the rows ask
    each referent's `LinkTarget` of (`LinkPlan.linkTargetIfReferentKey`).
    Both are Effects on the clock, run synchronously in the memo;
    their failures are states: a `DuplicateReferent` is `refused`, with the
    batch's last resolving that succeeded when a re-decode is what refused
    it (the screen keeps that review up under the refusal, confirm
    disabled, so the reviewer can undo the setting; on a first decode it
    says why and offers the picker), and a
    choice that cannot be resolved after a re-decode (`InvalidLinkChoice`)
    falls back, the reviewer's own to its searched default, a default to its
    kind's default. The screen blocks its first paint on the default
    search, as it does on the server diff, and hands the resolved batch to
    `useServerDiff`, `PreviewPanel` and the confirm, which take a
    `ResolvedBatch` and so see what gets written; a failed search shows an
    alert and leaves every referent on its kind's default.
  - `link-choice-review-state.ts` — the `LinkChoiceReviewState` types: the
    `Mapped` batch (referents, choices, search hits, the resolved batch with
    its plan, and the `mentionLinkOptions` the rows' mention selects offer), the
    `Type` of states (`loading`, `ready`, `error`, `refused`) and the hook's
    `Review` surface: `choose` for a referent, `chooseMention` for one
    mention of one resource.
  - `mention-link-options.ts` — `MentionLinkOptions`, the pure half of the
    per-resource mention selects, read off the plan (`fromPlan`): exactly
    its resolved resources (`LinkPlan.resolvedResources`), one per record
    that will exist once the batch is written, by the type it is, each a
    link choice option labelled by the resolved resource's `label` and
    paired with the `LinkChoice.MentionLinkChoice` picking it makes
    (`LinkToDecodedReferent` of its `ownerReferent`, so the mention follows
    that referent's later link; `LinkToStoredResource` for a stored record no
    referent owns, which no referent's later choice moves), plus each
    record's label by literal reference, which `describeResource` names a
    row's subject by.
  - `use-default-link-choices-search.ts` — `useDefaultLinkChoicesSearch`
    reads each referent's default once per batch
    (`ReferentSearch.defaultChoices`, a TanStack query keyed by the batch id,
    which also labels the stored resources the defaults link to), and starts
    the stored lists the rows offer beside it.
  - `use-reviewer-link-choices.ts` — `useReviewerLinkChoices` keeps the
    reviewer's choices on top of the defaults by `Referent.key` across a
    settings re-decode in a `ReferentLinkChoiceSet`, their link choice set
    by mention beside it in a `MentionLinkChoiceSet` (by
    `MentionLinkChoiceSet.key`, set by `chooseMention`), and the referents of
    the batch's first decode the search reads; a fresh pick starts over.
  - `use-last-resolved-batch.ts` — `useLastResolvedBatch`, the batch's last
    resolving that succeeded, which a refusal is shown over.

  The referent block, "People and providers in this import", is one file
  per job:
  - `referent-rows.tsx` — the block the panel renders above the format
    groups (its `referentRows` slot): a tally of the records the referents
    are linked to (`ReferentTally`: a stored record, or one this import
    writes, is counted once however many referents share it) and the
    referents that are unlinked, then one group per `LinkableLogicalReference.RESOURCE_TYPES`
    entry that has referents. A list that failed is said under its group,
    and only the search's hits are offered; a list the page limit cut off is
    said too. While the batch is `refused` the selects are disabled, since a
    choice could neither be resolved nor shown.
  - `referent-row.tsx` — one referent's line, memoised: its label, a select
    of its options, and its warning.
  - `link-choice-options.ts` — the `LinkChoiceOptions` view model: the
    options a referent's select offers, in four groups. `New`, or an update
    of the stored copy under its own id when one is known
    (`UpdateStoredResource`, a re-import's default), or a stored resource for
    an `AsResource` referent; a stored resource, `New: <label>`
    (`LinkToDecodedReferent`) for each other referent of its type that
    creates a record, `New` when `LinkableResource.tryProvisionalFrom` stands
    for its logical reference, and "Don't link" for a `ByMentionOnly` one.
  - `referent-line.ts` — the `ReferentLine` namespace: a group's lines (a
    referent, its choice, its options, its warning), each built once per
    change of what it is built from (its own choice, the stored list, the
    batch's referents and which of them write their own record) and kept
    across every other change, so a select change rebuilds the lines it
    changed and the memoised rows of the others skip their render. The
    warning is `DifferingDemographics`: a Patient linked to a stored one
    whose family name, given name or birth date (`Patient.demographics`, the
    parts the name-and-birth-date identifier is minted from) differs gets a
    warning line, never a block; a Practitioner has nothing compared.
  - `use-referent-group-lines.ts` — `useReferentGroupLines`, the group's
    React side: the stored options as one memo per group, shared by its
    lines, and the built lines kept in state across renders.
  - `use-stored-resources-of-type.ts` — `useStoredResourcesOfType`: the
    server's own stored resources, every page read up front
    (`GET <Type>?_count=` through `fhir-r4/clients`' `searchAllPages`, capped at
    ten pages: a select has no room for a load-more action, and a personal
    server holds a household, not a hospital), each labelled on the way in
    since `LinkableResource.labelOf` reads the clock. The read starts beside
    the default search (`useDefaultLinkChoicesSearch` starts the same query,
    `storedResourcesQuery`, as soon as the batch's referents are known) and
    is never stale on its own: a confirm invalidates it, the one thing that
    changes it.
  - `referent-text.ts` — the block's strings, which say "server", never
    "device": the importer can be pointed at any FHIR server.

- **`src/run/`** — the two hooks that drive the flow's halves, held apart from
  the view they feed: the read (`use-import-run.ts`) and the opt-in write
  (`use-confirm-import.ts`). The confirm hook is the write half and does not
  belong under `preview/`.
  `use-import-run.ts` is React state around `importer-core`: `run` calls
  `readBatch` (through `useRunAuthed`) over the whole pick and holds the
  resulting `DecodedBatch`, `applySettings` calls `redecodeFormat` for the
  one format whose settings changed — from that format's retained
  `PickedFile`s, keeping every id and review key, so keyed selections keep
  applying — and it owns the `FormatSettings` record, the `batchId` that tells
  a fresh pick from a re-decode, and the in-flight ticket that drops a stale
  result. It imports the registry rather than taking it as a parameter, so its
  dependency arrays say what they mean. Grouping, decoding, and folding
  outcomes all happen in the core.
- **`src/preview/`** — the review view and the state it needs.
  `use-server-diff.ts` pre-classifies every previewed resource against the
  server (`new` / `unchanged` / `changed`) for the row badges and the "already
  there, so pre-excluded" seed, keyed **by review group and then by resource
  key** (`GroupComparisons`, over `importer-core`'s `ReviewGroup`) — two
  formats can carry the same resource key, so
  a flat map would let one format's verdict overwrite another's. Within one
  format the keys are already distinct, because `DecodeFunction.make` namespaces each
  claimed file's keys by its slot in the batch. The screen blocks the
  first paint on it but **not** on the re-classification a settings change or
  a link choice triggers, since unmounting the panel mid-review would drop the
  focus of whatever control the reviewer is using; the verdicts the batch last
  settled on stay on screen (`refreshing`), a failed classification having
  settled on "every id is new", and the confirm waits for the new ones, since
  the pre-exclusions are read off them. A failed classification is retried
  twice before it is reported; a fresh pick carries nothing over.
  `preview-panel.tsx` renders the batch grouped by format — one group per
  `claimedFormats` entry, its settings form (the registry's own
  `SettingsPicker`, indexed by the format tag) over that format's sectioned,
  per-resource review — then the batch's **linked records** (`batch.linkedRecords`,
  the records it names but holds no copy of, as the referent rows link them)
  read-only with their diff badge and no toggle or edit, under one shared
  confirm, gated on the batch writing at least one resource. The panel's
  counts come off `importer-core`'s `planWrite`, the plan the confirm
  submits: the confirm names the `Included` decisions, one per `Type/id`,
  and the `Excluded` ones. Which linked records are written is that plan's
  too, not a toggle: none the server holds unchanged (`Unchanged`; the
  screen hands the panel and the confirm the same `unchangedLinked`, the
  linked group's `initialExclusionsFor`); otherwise every stored copy,
  whatever the reviewer excluded, since the link choice is the consent to
  it, and a new record only when an included resource names it, else
  `Unreferenced`. The diff keys its verdicts by
  `importer-core`'s `ReviewGroup`, a format or `LINKED_GROUP`, so the linked
  records' badges are their own. It is the
  panel, the actions and the editor dialog only; the review body it renders
  per format is
  `format-review-body.tsx` — named for what it covers, one _format's_ review
  across every file that format claimed (per-type tallies, one titled section
  per decoded section with include checkbox and one-line `describeResource`
  summary, Edit/Revert, unreadable-file rows, and the notes folded into a
  collapsed details block). Above the sections it lists every resource the
  referent links leave a mention unlinked in again
  (`UnlinkedMention.leftByReferentLinks` on the batch's plan, asked by
  `unlinked-mentions.ts` of each row as edited, else as decoded in the
  batch's `decodedBatch`, a format's own source file never),
  under **Needs a patient** (an unlinked or empty `subject`) or else **Needs
  a provider**, each with why in one phrase ("names no patient", "names an
  account you chose not to link", "names a provider you chose not to link",
  "points outside this import", as the row reads now); the group is a second
  view of the same rows, so a pick, which is no edit, keeps the row there
  and in focus, while an edit that gives its subject a record of the device
  takes it out. Every row whose resource makes a mention the
  map can link (`Mention.linkableIn`) carries an inline select per mention,
  read as part of its summary line ("for Tyra Banks", "requested by …"):
  the records offered for the type the mention names
  (`MentionLinkOptions`), the one it names now when none of them is it, plus
  Don't link where the mention keeps something to name or the referent
  choices leave it unlinked. A pick is a mention link choice in the identity
  map (`onChooseMention`), never an edit: the resolved resource redirects
  the mention there and the row is not marked edited; a row with an edit
  override has it relinked at that mention too (`Mention.relinked`), since
  the override is what gets written. A patient picked for a resource under
  Needs a patient includes it, Don't link leaves it out again, and Revert
  leaves one out again when the resolved resource has no patient either.
  `describe-resource.ts` reads a decoded resource in its wire form and names
  its subject by the label of the resource it is redirected to, else its `display`,
  never by its `Patient/<id>`. A section's tri-state heading toggle is
  `section-toggle.tsx` — `{ title, keys, isIncluded, onSetIncluded }`, the
  `indeterminate`-via-ref pattern — shared with the server source-file list's
  study sections, which passes its own selected-id set where the review body
  passes `StagedImport`. The server-diff badge and its field-level
  disclosure are `diff-badge.tsx`, and every user-visible string is
  `preview-text.ts` — imported from there by everything that shows one,
  including this package's `index.ts`, rather than re-exported through the
  panel.
  `use-confirm-import.ts` is the opt-in write action: `planWrite` (in
  `importer-core`), then one `persistTransactionBundle` of exactly the
  resources of its `Included` decisions, in the plan's order, the linked
  records first. It adds nothing to any
  resource — no id locking, no provenance stamping — because the format's
  `decode` already minted the source file and stamped every extracted
  resource's `meta.source`. The transaction lands whole or not at all, so a
  rejected entry refuses the batch and every entry reports the one cause;
  there is no separate upload step to fail.
  `resource-editor.tsx` (+ `resource-editor-helpers.ts`) is the inline JSON
  editor: **Keep** parses the text, decodes through
  `Schema.decodeUnknown(FhirResourceSchema)`, and refuses the edit unless it
  parses and preserves `resourceType` / `id`; `describe-resource.ts` is the
  pure one-line summary per resource type. Both moved here from
  `har-importer-react` when the review display was generalized.
- **`src/results/`** — the outcome. `import-outcome.ts` is the pure fold: the
  per-format `ImportOutcome` and the `FileImportResult`/`BatchOutcome`
  aggregate (`summarizeBatch`, `isPartialBatch`) — the `files` and, beside
  them, the `linked` records' results, counted as resources and never as
  files — every row carrying the format result's `title` (its claimed file
  names, or the linked records' heading) rather than a file name of its own,
  all on `collectImportSummary` semantics (any failure ⇒ partial; nothing
  written of what was attempted ⇒ failed);
  `import-results.tsx` renders the batch grouped by response code — every
  submitted resource (the source file included) with its status, plus the
  formats that had nothing to import — under one aggregate tally, which a
  batch that wrote linked records alone words as such rather than as
  resources across no file. Only claimed
  formats appear: a format that took no files is not a "nothing to import"
  row. There is no
  upload-failed section: a rejected source file is an ordinary failure row.
- **`src/sources/`** — the picker. Every source here yields
  `PickedFile.NamedBytes` (`{ fileName, bytes }`); the id a pick is known by is
  `importer-core`'s `readBatch` to mint, and nothing in this directory does.
  `local-file.ts` is the
  format-blind "read a local file's bytes and identify it against the
  registered formats' `detect`" gate — no format's `decode` runs at
  pick time; `server-source-file-list.tsx` is the uploaded-source-files pick
  source (one flat list of rows, paged by a bottom sentinel, a per-row
  selection control and an explicit **Preview** with the raw-contents modal it
  opens), spanning every registered format through
  `PickedFile.FromDocumentReference` under that format's constants, and
  exported for the anonymizer shell's `serverSource` slot as much as used
  here. Its one knob is **`maxPicks`**: left out there is no cap, and the one
  **Use selected as source** action fetches every checked row and hands them on
  as one list; `maxPicks={1}` renders the rows as radios sharing a name — so
  selecting one deselects every other — and names the action **Use as source**;
  any other cap disables the remaining checkboxes once it is reached.
  `source-picker.tsx` composes the drop-and-pick zone, the file input it opens,
  a **Choose files** button, a **Choose a folder** button, and that server list.
  There are no modes: a local pick is never trimmed, and the server list inside
  it is mounted with no cap. The folder pick is the same batch path —
  a DICOM study arrives as a directory of hundreds of `.dcm` files, and the
  files it yields go through the same detectors and the same by-name rejection
  notice. The list decides
  nothing about what an import _is_ — and groups nothing: a row that names a
  `context.related` resource shows it as a secondary line, the selected rows go
  on as one pick, and the format's `decode` groups them.
- **`src/queries/`** — the reads. `source-files.ts` is the paged, format-blind
  `DocumentReference` search: one request per page with `category` set to
  the comma-joined `system|code` tokens of every registered format
  (`SOURCE_FILES_CATEGORY_TOKEN`), each returned resource classified by
  dispatching `PickedFile.isSourceFile` over every format's `sourceFileFormat`
  in registry order (disjoint by construction) so rows are tagged with the
  format they came from, each row dated by the stored resource's own
  `meta.lastUpdated`; plus `fetchSourceFile` — the one
  fetch-and-decode through `PickedFile.FromDocumentReference` under that
  format's constants, which both a row selection and the preview modal read
  through.
  The continuation cursor comes out of a bundle's `next` link through
  `fhir-r4/clients`' `nextPageToken` (see the trap); `keys.ts` holds the
  query-key roots.
- **The source file is a reviewed resource the format minted.** Every pick's
  source file `DocumentReference` is minted inside that format's
  `decode` (by the batch decode `DecodeFunction.make` built) and arrives as its own
  "Source file" section ahead of that file's extracted ones, keyed
  `<pick id>/source-file/<fileName>`. The shell neither mints it nor
  keys it, and dispatches on no format tag to get it: it reviews the row like
  any other resource, so the reviewer can edit its JSON or skip it. A settings
  re-decode re-mints it at the same deterministic id, so the review key and the
  `meta.source` links survive — and so does re-picking the same file off the
  server, which is why its row comes back `unchanged` from the diff and
  pre-excluded from the initial selection. The source-file list query is
  invalidated once at end-of-batch (a fresh source file is a new
  `DocumentReference` the picker should see next pick — cheap even when none
  wrote).

## Traps

- **The read half writes nothing, and the split is the whole product.** Reaching
  a review issues no writes — `decode` requires no services and is run for its
  data only, and the confirm writes exactly the reviewed objects
  (`planWrite`'s `Included` decisions over the formats' decoded sections)
  with no re-parse. A test pins this on the wire (zero writes to reach a review, and
  the reads are the source list, one identifier search per referent, the diff
  bundle and the stored resources per referent type); do
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
  each format was reviewed with (`planWrite` reads each format's own
  decoded sections under it). Same for
  settings: the panel renders `settings` and reports `onSettingsChange`;
  `useImportRun` owns the record and the re-decode. Don't move either down
  into the panel, or the shell and the view can disagree.
- **The confirm is one `persistTransactionBundle`, and nothing is stamped at
  confirm.** `planWrite` (in `importer-core`) turns the formats' decoded
  sections plus the reviewer's selections, and the batch's linked records,
  into a **`WriteDecision`** per reviewed resource — `Included`, `Excluded`,
  `Unchanged`, `Unreferenced` or `Superseded` — a set leading with its
  source files in the same bundle as its
  extracted resources, no upload-then-persist sequence and no ordering to
  protect. `importBatch` hands the `Included` decisions' resources, in the
  plan's order, to one `persistTransactionBundle`: it does not look for the
  source file, lock an id, or write `meta.source`, because the format's
  `decode` already minted the source file at a deterministic id and stamped
  every extracted resource with its reference. A source file row the reviewer
  **excluded** is simply not written, and the resources keep their
  `meta.source` — the link points at a `DocumentReference` this batch chose not
  to upload, which is the reviewer's decision, not a rewrite the shell makes.
  The batch is one Effect run through `runAuthed`, and its outcomes are handed
  back by position: the write reports one outcome per resource handed in, so
  each `Included` decision is zipped with its own outcome and the pairs
  grouped by the decision's `ReviewGroup`, a claimed format's becoming its
  `imported` result (attempted its `Included` count, excluded its `Excluded`
  count) and the linked group's the linked records' results. `useConfirmImport`
  needs nothing from the registry — persistence is format-blind.
- **The batch lands whole or not at all, and there is no upload-failed case.**
  The batch is resolved as one: a format's resources point at the linked records
  and at referents another format holds, so a server holding half of it would
  hold references to records it does not. One `transaction` bundle, which
  the server lands every entry of or none (`fhir-r4-rust`'s
  `batch_bundle_at_base.rs` pins HFS doing so), rather than one `batch` per
  format. `persistTransactionBundle`'s error channel is `never`, so a refusal
  is every entry's outcome under the one cause, not a raised error. A claimed
  format with no `Included` decision (no kind recognized it, every matching
  kind toggled off, or every file unreadable; `skipReasonFor` says which) is
  `skipped`, never a failure, and never reaches the bundle. `isPartialBatch` lifts
  `collectImportSummary` to the batch: any rejected resource, a linked record
  included, makes it partial, and `import-results.tsx` frames a batch nothing
  of which wrote as failed; a `skipped` format alone does neither. There is
  **no** whole-flow `errored` state and no `uploadFailed` result — a refused
  batch is its rows in the results, their cause the server's own response.
- **The confirm affordance is gated on the batch having a resource to
  write.** `PreviewPanel` shows the single confirm button only when
  `planWrite`'s plan — over the **claimed** formats' rows and the linked
  records — has an `Included` decision; unreadable
  files and formats whose decode yielded nothing render their own section but
  add nothing to write, a linked record the server holds unchanged, or a
  new one no included resource names, adds nothing either, and two rows
  under one `Type/id` count once, the earlier `Superseded`. A changed stored
  copy alone is something to write, so the confirm can be offered with every
  format's resources excluded; the results then say no file's resources
  were imported. The confirm reads the same
  plan, so the count and the write cannot disagree, and both come off
  `claimedFormats`, the one predicate for "did this format take part" — a
  format that claimed nothing is not planned, tallied, or reported.
- **The source file list is format-blind and disjoint from web traces on the
  same axis.** The list searches `category` for `SOURCE_FILES_CATEGORY_TOKEN` —
  the comma-joined `system|code` tokens of every registered format's
  source file coding (`WEB_TRACE_CODE_SYSTEM|har-archive` for HAR, the LifeLabs and DICOM
  systems for theirs), built at module
  load from `PickedFile.categoryToken` over each format's `sourceFileFormat`,
  so it cannot drift from what the mint writes. Each returned resource is
  classified in registry order through `PickedFile.isSourceFile`; the predicates
  are disjoint by construction (each tests a different `system|code`),
  so at most one claims any row and a row no predicate claims is
  dropped. Web traces sit under a different category code on the same
  system; `isWebTrace` and any format's source-file predicate never both
  hold. The list must never surface a trace.
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
- **`fhir-r4/clients`' `nextPageToken` reads a present-but-empty
  `_pageToken=` as token-less.** `''` is not `null`, so TanStack Query would
  take it for a real cursor and re-request page one forever.
- **The list carries rows, not source files.** A source file's bytes are the whole
  file, potentially megabytes (a multi-MB HAR, a PDF); `SourceFileRow` holds
  only the id, its classified format, the title, what it is a source of, and
  the stored resource's `meta.lastUpdated`.
  `fetchSourceFile` reads the one file the user selected or previewed. Listing
  the bytes to render a title would pull every source file onto the device to
  draw a list.
- **A row selection decodes through its format's source file codec and keeps
  the bytes verbatim.** `fetchSourceFile` decodes
  `PickedFile.FromDocumentReference` with the row's format's
  `sourceFileFormat` provided as the `PickedFile.Format` service — the one
  place above `importer-fundamentals` that provides it — so a
  resource that is not a source file of that format fails as a `ParseError`,
  never yields nonsense. It hands on the stored file's own name and bytes and
  nothing else: re-picking mints the source file it came from, because the id is a
  hash of exactly those two.
- **A row's Preview action opens a read-only raw-contents modal that
  renders the file itself.** The modal fetches through
  `fetchSourceFile` (the same read as a pick) and picks its renderer from the format's
  `sourceFileFormat.contentType`: PDF via
  a `<iframe>` at a `blob:` URL over the
  bytes (revoked on unmount), JSON pretty-printed inside a `<pre>`
  capped at `JSON_PREVIEW_SIZE_LIMIT` (5 MiB) with a "Download raw"
  fallback for a giant source file. The modal writes nothing and offers no
  editing — a preview is inspection, not another entry point to the
  review flow.
- **A source file's id is derived from its bytes and name, so re-importing upserts.**
  The mint `DecodeFunction.make` runs inside each format's `decode`
  derives the resource id with `localResourceId` over the file's SHA-256 and
  name — deterministic, not a per-pick uuid — so its bundle entry is a PUT to a
  stable `DocumentReference/<id>` and re-importing the same file under the same
  name overwrites in place rather than piling up duplicates; a file re-picked
  off the server mints the source file it came from. The attachment's
  `hash` and `size` still describe the bytes, and the source file states no instant
  at all. (Result ids are also
  deterministic — `FormatDecode.makeId` over the format tag and each picked
  file's id — so there is no client-side `crypto.randomUUID()` anywhere in
  the flow.)
- **Upload takes bytes, not text.** The source file mint stores the file
  verbatim so a truncated or mis-encoded upload is preserved and the
  attachment `hash` means something. `PickedFile.bytes` is a `Uint8Array` from
  the picker all the way to the mint, and nothing in between re-encodes it.
- **A group format's files are re-picked together or not at all.** Picking one
  source file of a study off the server yields a one-file study, which is a
  different `ImagingStudy` than the one that was imported. That is why the list
  is multi-select and hands every selected row on as one pick, and why each row
  shows what it is a source of (`context.related` — a study's source files name the
  `ImagingStudy` they were read into, which `subject` cannot distinguish, since
  every study of one patient shares it). The line is a label, not a grouping:
  what the rows make up is the decode's `groupBy` to decide.
- **The drop zone is a button, so drop is an enhancement rather than the only
  path.** The zone itself opens the file picker on click, so the whole
  surface is keyboard-reachable and screen-reader named; the
  `<input type="file">` it opens is visually hidden but kept a named,
  reachable input (`aria-label="Import file"`), not `display: none` — some
  upload implementations refuse an invisible input. The folder pick's input is
  the same, named `aria-label="Import folder"`; `webkitdirectory` is set on it
  through a ref rather than as JSX, since React does not declare the attribute
  and writing it as a prop would need a cast.
- **The authed runner comes from router context, one way.** `useSourceFilesQuery`,
  the picker's row-select, and the preview modal's fetch all read
  `useRunAuthed()`; the query also exposes
  `sourceFilesInfiniteQueryOptions(runAuthed, options)` taking the runner as
  its first argument, for a loader or a test that drives the query itself.
  There is no prop-threaded second way in.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
and [React Testing Reference](../../../docs/Testing/React%20Testing%20Reference.md).
Use the workspace-local `node_modules/.bin/vp` for jsdom runs.

- `sources/source-picker.test.tsx` mocks only the router seam
  (`vi.mock('@wildflowerhealthio/fhir-r4-react', … useRunAuthed …)`) and drives the whole picker over
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
  the re-picked server source file (its row present and pre-excluded, nothing
  uploaded), the multi-file batch (the resources two files share under one
  `Type/id` counted and written once), the per-file source file failure, the
  partial-write fold,
  that a single-format import reports no blank "nothing to import" rows, and
  cancel. It re-wraps `TextEncoder` output through the ambient `Uint8Array` (a
  jsdom single-realm workaround; the production encode stays `new
  TextEncoder().encode(text)`). Its stub server holds what it is seeded with
  and what is written to it, and answers identifier searches and paged lists from that, so it also
  pins the identity map: the reads to reach a review, a confirm linked to a
  stored Patient (only the stored one written, carrying the source's
  identifier, every subject on it), a re-import that defaults the Patient to
  an update of the copy it stored and is `unchanged` and left out, one referent for one identity two files name,
  a resource naming no patient left out until one is assigned, a subject
  picked onto the Patient redirected to the stored record the Patient is later
  linked to, and an edit on a Patient's row dropped when that Patient is
  linked to a stored one.
  Its stub refuses a `transaction` one of whose entries fails as a whole, as
  HFS does, which pins the confirm landing nothing and saying so.
- `identity/referent-rows.test.tsx` drives `useLinkChoiceReview` and the rows over a
  hand-built batch and a stub search: a line per referent, people before
  providers, `New` without a hit, a hit pre-selected, an update over the copy
  found under the decoded id, the demographics warning,
  and a changed select resolving the batch.
- `preview/format-review-body.test.tsx` drives one format's body over a file
  resolved on the identity map: Needs a patient only when a subject is
  unlinked, a pick that is a mention link choice and includes the row, Don't
  link leaving it out again, a pick following its referent's later link,
  where Don't link is offered, and an edit override relinked by a pick.
  `identity/mention-link-options.test.ts` pins what a select offers: the
  plan's resolved resources, a record two referents are linked to once, as
  the choice of the referent whose record it is.
- `preview/preview-panel.test.tsx` drives the pure panel by props — no router —
  and pins that a claimed format renders each decoded section under its own
  title with per-resource checkboxes, that an unreadable file renders its own
  alert, that a mixed batch sums to one confirm over every claimed format's
  sections, that two rows under one `Type/id` count once, that each
  registered format mounts its own settings picker, and that the confirm
  appears only when at least one resource is included.
  `results/import-outcome.test.ts` is the property/example test for the folds.

## References

- [slices/importer AGENTS.md](../../../slices/importer/AGENTS.md) — the slice's package roles,
  guardrails, and the per-URL pick-review-confirm pipeline this package's flow
  drives.
- [importer-fundamentals AGENTS.md](../../../slices/importer/importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract and the `StagedImport` model this shell drives.
- [importer-core AGENTS.md](../importer-core/AGENTS.md) — the importer
  registry and the batch machinery these hooks wrap.
- [har-importer-core AGENTS.md](../../../slices/importer/har-importer-core/AGENTS.md) — the HAR
  importer (`decode` plus the server-read seam) the core registry lists.
- [har-importer-react AGENTS.md](../har-importer-react/AGENTS.md) — the
  `HarSettingsPicker` this shell mounts per HAR group.
- [slices AGENTS.md](../../../slices/AGENTS.md) — the slice layering rules this package
  follows.
- [web-trace-core AGENTS.md](../../../slices/web-trace-core/AGENTS.md) — the
  coding a HAR source file shares an axis with, and the disjointness of traces
  and source files (a test-fixture dependency here, nothing at runtime).
- [fhir AGENTS.md](../../../slices/fhir/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
