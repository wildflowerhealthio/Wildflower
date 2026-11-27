# AGENTS.md — slices/importer/importer-react

The browser UI adapter of the importer slice, and its **shell**: the whole
flow from choosing files to writing their import plan, plus the React half of
the closed format registry. One surface a host app mounts, reading the authed
runner out of router context:

- **`ImporterScreen`** — choose one or more files (local files dropped or
  chosen, or source files already on the FHIR server), read them into an
  **import plan** against the existing records, review the plan on the
  import plan page, and write it as one transaction. Every source picks a
  **batch**: several local files, several folder entries, several server
  rows.

The read and the plan — splitting a batch by the format that claims each
pick, running each format's `decode`, matching the records against the store,
suggesting a choice per record and resolving the plan — are `importer-core`'s
and `importer-fundamentals`', and pure but for the store's searches. This
package is the React state, the views, and the write around them.

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
It depends on `importer-core` (the importer registry, `readBatchCopies`,
`planImport` and `findStoredMatch`, and the `readBatch` / `redecodeFormat` /
`planWrite` the unmounted review runs), `importer-fundamentals` (the
`PickedFile` vocabulary, `FormatDecode`, and the import plan: `ImportPlan`,
`resolvePlan`, `countTotals`, `PlanTotals`, `ImportWrite`, `ImportedRecord`,
`RecordChoice`, `locateReferences`, `differencesInPlan`),
each format's React package for its settings picker only
(`lifelabs-pdf-importer-react`, `dicom-importer-react`; HAR has no settings and
no React package), `fhir-r4` (the typed client, `persistTransactionBundle`,
`HumanName`), `fhir-r4-react` (the authed runner and the slice runtime layer),
`positioned-text-web` (the pdfjs `PositionedTextExtractor` layer the read runs
under), `react-kitchen-sink` (`cn`, `prefersReducedMotion`) and
`react-tundraish`. It names no format's core package and no
`web-trace-core` at runtime — HAR fixtures in `screen-fixtures.ts` are the
only place `http-archive` and `web-trace-core` appear at all.

The seam between this package and a format is its **`FileImporter`** (reached
through `importer-core`'s registry) and the import plan: the read runs
`readBatchCopies` (no writes) into each claimed format's copies of records,
`planImport` matches them against the store and suggests a choice per record,
`resolvePlan` resolves it, and the write sends the resolution's
`ImportWrite.Ready` resources through one `persistTransactionBundle`. If a
component needs more than those expose, widen them rather than reaching around
them.

**Presentation and interaction only.** Nothing here parses a file, mints or
encodes a source file, runs entities, or writes resources. The parsers, the
source-file mint, `decode` (including each format's recognition),
and the batch machinery all live below this package; it drives them and
reimplements none.

## The registry

`src/registry.ts` is `importer-core`'s closed `format → FileImporter` registry
with the React part a format contributes — its `SettingsPicker`, for a format
that has settings — attached to each entry by `withComponents`, a
**spread**, not a subclass: a
`FileImporter` is a plain record with no prototype, so the spread is total and
a field added to it cannot be silently dropped on the way through. The importer
half is registered in `importer-core/src/registry.ts`; this file is the single
edit point for a format's UI. **`FormatWithComponents<K>`** — named for what it
adds, and defined as `importer-core`'s `BoundFormat<K>` intersected with the
picker slot rather than restating it — keeps per-format concrete types against
`FormatSettings[K]`, so a picker typed against another format's settings fails
to compile here. The slot is conditional per format (`SettingsPickerSlot<K>`):
forbidden for a format whose `FormatSettings` entry is `null`, required for
every other, so a format with settings that is missing its picker fails to
compile too. `har`, `lifelabs-pdf`, and `dicom` are registered; `har` has no
settings, so its entry is `importer-core`'s importer as it is.
This module exports **only what it adds**: `defaultFormatSettings`,
`formatKinds`, `FormatKind` and `FormatSettings` are `importer-core`'s and are
imported from there directly, since re-exporting them here gave the package two
routes to the same symbol and it used both. There is no format-specific review UI slot: the
import plan page shows every format the same way, from its records.
The importer has no HTTP wire union to derive, so there is no separate
`importer-registry` package.

## Module layout

- **`src/importer-screen.tsx`** — the flow, top to bottom: one exhaustive
  `Match` over the page hook's state (`useImportPlanPage`), one component per
  case. Choosing files is the `SourcePicker`; reading is react-tundraish's
  `GateCard`, the loader card; a failed read is a danger `Notice` with
  **Choose other files** as its action; reviewing and importing are the
  `ImportPlanPage`; imported is the `ImportCompleteNotice`. Every message
  of the flow that is a notice is react-tundraish's `Notice`, so it looks
  and announces as an `ErrorBanner` does.
  It reads everything from router context (no props).
- **`src/plan/`** — the import plan page.
  - `use-import-plan-page.ts` — `useImportPlanPage`, the page's logic. Its
    state is `ImportPlanPageState`, a `Data.TaggedEnum`: `ChoosingFiles`,
    `Reading`, `ReadFailed`, `Reviewing { review, writeFailure }`,
    `Importing { review }` and `Imported { review }`. A `Review` is the batch
    as read (`BatchCopies`), its `plan`, the plan's `resolution` with its
    `totals` (`countTotals`) and its `write` (`ImportWrite.of`), its
    `differences` (`plan-differences.ts`), its `recordReferences`
    (`locateReferences`, located once when the files are read, since a
    choice changes where a reference lands, never which record it names),
    and `readAt`, the instant the files were read, at which a person's name
    in use is judged. `reviewOf` builds one from a plan and is the one way a
    plan becomes a `Review`, so the hook owns the totals, the write and the
    differences, and the components only read them. `read(picks)` runs
    `readBatchCopies` under the default format settings, `planImport` with
    `findStoredMatch`, and `reviewOf`, through `useRunAuthed`.
    `choose(keys, choice)` makes `choice` the reviewer's for every record
    under one of `keys` (`ImportPlan.choose`), and `reset(keys)` clears the
    reviewer's choice for each, back to its suggestion (`ImportPlan.reset`),
    both only while `Reviewing`: each runs `reviewOf` synchronously in the
    handler and commits the new review keeping the last `writeFailure`,
    since the reviewer reads it while fixing the plan and what it says stays
    true; Import pressed again, or starting over, clears it.
    `importPlan()` writes the review's `ImportWrite.Ready` resources as one
    `persistTransactionBundle`: every outcome ok is `Imported`; otherwise it
    is `Reviewing` again with its `writeFailure` (`write-failure.ts`:
    `Refused`, or `Unanswered` when an outcome got no readable answer) and
    the plan untouched. `startOver()` goes back to `ChoosingFiles`. The state
    lives in a ref beside the React state, written together, so an action
    reads what the next action needs; one ticket drops a stale read or write.
    Any failure of a run, a failed search, a defect or the runner's own
    rejection, is logged (`Effect.logError`): a read ends in `ReadFailed`,
    which holds nothing, since nothing in a failure is worth showing a
    reviewer, and a write goes back to `Reviewing` with `Unanswered`. A write
    that was sent invalidates the source-file list and the stored records
    before the stale check, since it may have landed either way.
  - `plan-differences.ts` — the `PlanDifferences` namespace: each record's
    **candidates**, the existing records it could merge into, worked out
    once per plan by `ofPlan` (since `differencesInPlan` reads the whole
    plan on every call). A `Candidate` is the stored resource a choice
    names (`existing`), how the plan knows of it (`knownBy`, an
    `ExistingRecord.KnownBy`), and `inPlan`, `differencesInPlan`'s
    `incoming`, `kept` and `differences`. The candidates of a record are its
    existing records (`PlannedRecord.existingRecordsOf`): the search's
    matches, best grade first, then the record under its derived id, then
    the one the reviewer chose when it is none of those. Every record that
    has an existing record is worked out, since a card's options and a row's
    reason tag, fold and options all read them, once per plan value: every
    choice makes a new plan and computes them again. Each candidate is a pass
    over the whole plan (`differencesInPlan`), so a choice costs the records
    with an existing record times their candidates times the plan, which on
    a re-import, where every record has one, is quadratic in the plan's size;
    making it cheaper is #1566.
    It also reads, off candidates, whether one differs on a field, the fields
    they differ on, the identity fields none differs on, the fields a choice
    takes into one, how much of its differences a merge takes
    (`takenShareOf`: `Every`, `Some` or `None`, over its current differences
    only), and the identifiers a merge into one adds
    (`IdentifierUnion.missingFrom`).
  - `write-failure.ts` — the `WriteFailure` namespace: why a write did not
    end in an import, read off its outcomes (`fromOutcomes`).
  - `import-plan-page.tsx` — the `Reviewing` / `Importing` view: one column
    at most 720px wide holding the summary, the records that need a
    decision, the import bar, the records decided automatically and a
    centred **Cancel import**, which is gone while the write is in flight.
  - `summary-card.tsx` — the kicker, "N records from M files" (M counts every
    picked file, those nothing was read from included), the four counts
    (Create, Update, Link to existing, Needs a decision, the last
    warning-coloured with "N open" while any record has no choice; two
    columns below 768px, four from it), one line per file set, and one red
    line per unreadable or unrecognised file.
  - `needs-a-decision.tsx` — the **Needs a decision** section, only when a
    record needs one (`PlannedRecord.needsDecision`, read off its
    suggestion, so a decided record stays listed): the heading, why these
    records are asked about, and one `DecisionCard` per record in plan
    order, each given how many records reference it
    (`RecordReferences.referrersOf`), its candidates, its DOM id (its index
    in the plan's records, which a choice never changes;
    `decision-card-ids.ts`, which also gives its React key, its record key
    as text) and whether the write is in flight.
  - `decision-card.tsx` — one record that needs a decision: "Select a
    Patient record for Tyra Banks from `b.har`", a meta line ("Not
    selected" while nothing is chosen; "N identifier matches" for a record
    several existing records carry the identifier of, else "N possible
    matches" and the identity fields no match differs on; the referrers),
    and one
    react-tundraish `RadioCardGroup` named by the title: the imported
    record's dashed option (Save as a new record), one raised option per
    candidate (Use this existing record: its kicker's parts, each kept
    whole, its last-updated date and grade,
    each identifier the merge adds, and a `DifferencesTray` when it has
    differences), then a full-width Don't add line. Each option shows the
    fields any candidate differs on (never `name`, the option's title), its
    own value, "Not recorded" when it has none, an existing record's bold
    where the field is one of its differences, and as JSON where it would
    read alike with the imported record's though it differs; the selected
    option says what the choice does. Using an existing record takes the
    fields that fill a gap and none that overwrite one
    (`RecordChoice.mergeFillingGaps`). Its edge is the warning colour while
    nothing is chosen. While the write is in flight one `<fieldset
    disabled>` disables every control in it, and react-tundraish's
    `RadioCard` picks nothing for a click on a card whose radio is
    disabled.
  - `differences-tray.tsx` — an existing record's differences, in its
    option's tray: "Differences" over one line per difference (`field gains
    value` for a gap, green; `field kept → incoming` for an overwrite, each
    side as JSON where the two would read alike) while
    the option is not selected; once it is, one "Update with import details
    · K of N" checkbox over the same list (the count only when more than one
    field differs), checked when every differing field is taken, empty when
    none is, partly checked otherwise. A click
    takes none when every one is taken (a link), else every one. It is the
    parent of the per-field list #1469 adds.
  - `import-bar.tsx` — the sticky bar: the sentence and the Import button
    ("Import · 47 new, 2 updated, 65 linked", described by the sentence), or
    a warning line naming the first record with no choice, **Go to record**
    (which scrolls that record's card into view, smoothly unless the reader
    asked for reduced motion, and focuses its first radio) and the button
    disabled, or, when nothing would be written, a sentence alone (one for a
    plan whose records are all the same as existing ones, one for files no
    record could be read from). Why the last write did not end in an import
    is said above it, in a danger `Notice` listing each distinct refusal. Below 768px the bar's own box goes (`display:
    contents`), so the sentence scrolls with the page and only the action's
    box sticks; the warning line and Go to record sit inside the action, so
    they stick with the button it disables.
  - `decided-automatically.tsx` — the **Decided automatically** section,
    only when a record needs no decision: a divider, the kicker "Optional",
    the heading, "N records. Matched by identifier, or with no similar
    existing record. Change any; changes are listed first.", then its
    sections (`plan-sections.ts`, worked out once per review), all in one
    `<fieldset disabled>`, named by the heading, while the write is in
    flight, so every select, menu, Reset, Show more and fold line is
    disabled. Each section is a region named by its visible heading
    (`aria-labelledby`); a file set's by the format and the files' title.
    `people-section.tsx` is the Patients and
    Practitioners, wherever they come from ("Patient and Practitioner",
    "Other records reference these.", a group per type, no menu);
    `file-section.tsx` is one file set's other records, under the format's
    `display.title` from the registry and the set's title in mono, a group
    per type.
  - `plan-sections.ts` — the `PlanSections` namespace, pure: the sections of
    Decided automatically read off a review (`sectionsOf`), every record
    that does not need a decision in exactly one group, so a card's record
    is never also a row. A `Section` is `People` or a `FileSet` (by its
    origin, in the order the sets first bring such a record; a record
    several sets bring is under its record copy's, `ImportedRecord.originOf`),
    each holding `Group`s by type in the order the types first come
    (people: Patient, then Practitioner). A `Row` is the resolved record, its
    label (`RowLabel`, never `Open`, since a record decided automatically
    always has a choice), its suggestion's reason narrowed to a
    `DecidedReason`, the differences of the merge its suggestion makes
    (`suggestedDifferences`, from the review's differences), its title and
    detail (`row-text.ts`, every record of the plan titled once per review),
    how many records reference it, and its candidates, each with the title
    its option names it by. A group's `listed` rows run changed first, then by
    label (Update, Create, Don't add and not needed, Link to existing), plan
    order among equals (`rowOrder`); its `folded` rows are those the same as
    existing (`isSameAsExisting`: one identifier match, no differences from
    the record it merges into, linked, not changed). It also gives a group's
    keys (its menu acts on every record, folded ones included), and holds
    its counts by label; it gives a page of its listed rows
    (`listedPageOf`: the first `FIRST_PAGE_SIZE`, 6, then `PAGE_SIZE`, 20,
    more per "Show more") and a row's last line (`reasonLineOf`). Long
    groups page with "Show 20 more" where the style guide prefers infinite
    scroll: the design and the maintainer chose it for these groups
    (2026-11-27).
  - `record-group.tsx` — one type's rows, no landmark of its own:
    "MedicationRequest · 9" (every row, folded ones included), its status line ("2 new · 7 linked"), in a
    file set's section a `Menu` "Set every MedicationRequest" (Create all N,
    Reset to suggested, Don't add any, the last destructive), the listed
    rows a page at a time, "Show N more", then "N same as existing ·
    Show/Hide" over the folded rows. The rows, "Show N more" and the fold
    line are one keyed list, so a row keeps its element, and its select its
    focus, when a choice moves it between the folded and the listed rows.
    How many rows are shown and whether the fold is open are its own state,
    kept across a choice since the group is keyed by its type within its
    section.
  - `plan-record-row.tsx` — one row: react-tundraish's `RecordRow` with the
    row's title, a Changed `Chip` and Reset (the hook's `reset`) only when
    the reviewer changed its choice (`PlannedRecord.isChanged`; Reset takes
    itself away, so it commits the reset and moves focus to the row's
    select), its detail
    and its last line, and a select named "On import: {title}" of
    `row-options.ts`' options: one "Use {title}" per existing record
    (choosing it merges taking the fields that fill a gap,
    `RecordChoice.mergeFillingGaps` over its current differences; ", updated"
    and the success tone exactly when the merge the option stands for, the
    record's own when it merges into that record, else the one picking it
    makes, takes at least one of that candidate's current differences, the
    neutral tone otherwise), then Save
    as a new record (accent) and Don't add (muted). The selected option is
    the record's choice: a merge selects its existing record's option
    whatever fields it takes.
  - `reason-tag.ts` — a row's tag, the suggestion's whatever the reviewer
    chose since: "Identifier match · same as existing", "Identifier match ·
    N field(s) differ" (`suggestedDifferences`), or, with no field differing
    but the record counted an `Update` (an identifier or a link it adds),
    "Identifier match · adds an identifier or a link"; "New · no match",
    "New · not referenced". `DecidedReason` is a suggestion's reason that
    `Suggestion.needsDecision` does not list under Needs a decision, so a
    row's tag is exhaustive over what a row can have. A person's last line adds its file and its
    referrers; a record that is `Unneeded` adds that it is not written.
  - `row-text.ts` — a row's title (a person's name, else the resource's
    one-line summary, `describe-resource.ts`' `summaryIfDescribed`, else
    the plan's title for it), an existing record's title in an option (the
    same, else its literal reference), and its detail (`RowDetail`): a
    Patient's birthDate and gender ("No birthDate"), a Practitioner's key
    identifier in mono ("No identifier"), any other record's resolved
    references as `field: display` ("No references" for none), the display
    being the title of the record of the import a reference names by
    literal (where it is written or linked, or a stage literal a reference
    to a record with no choice yet keeps) or by identifier, whatever its
    choice, with " (display only)" for a record not added or a reference
    that names nothing, else the reference's own display, else its literal.
  - `describe-resource.ts` — a resource's one-line summary per type, read in
    its wire form; also the old review's (below).
  - `import-complete-notice.tsx` — a section labelled by its heading,
    **Import complete**, then a success `Notice` of what was created,
    updated and linked, with **Import more files** as its action.
  - `plan-text.ts` — every sentence, label and plural the page shows.
    `record-text.ts` — how a record or resource is named in a sentence:
    `titleOf` (a record: a Patient's or Practitioner's name, else the plan's
    title for it), `titleOfResource` (a stored resource: a person's name,
    else its literal reference), `fileTitleOf` (the file set it is listed
    under) and `statedIdentityFieldsOf` (name, birthDate, gender for a
    Patient; name for a Practitioner). `field-value-text.ts` — a top-level
    field's value as text: each name as shown, an address as its lines,
    each contact point as its system and value, each with its `use`;
    identifiers as their values (in mono); `extension` as how many; the
    common FHIR shapes by what they say (a Narrative as "Narrative", a
    CodeableConcept, Coding, Reference, Period or Quantity as its text);
    anything else as compact JSON cut short at 80 characters, the whole in a
    tooltip (`field-value.tsx`). `differenceTextsOf` shows two values that
    differ but would read alike as JSON.
- **`src/registry.ts`** — the React half of the closed format registry (above).
- **`src/identity/`** — **Not mounted, awaiting #1466.** The identity map in the old review.
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
    falls back, the reviewer's own to its matched default, a default to
    `New`. The screen blocks its first paint on the batch's match, as it
    does on the server diff, and hands the resolved batch and its stored
    candidates to `useServerDiff`, and the resolved batch to `PreviewPanel` and the
    confirm, which take a `ResolvedBatch` and so see what gets written; a
    failed match shows an alert and leaves every referent on `New`.
  - `link-choice-review-state.ts` — the `LinkChoiceReviewState` types: the
    `Mapped` batch (referents, choices, the stored resources the defaults link
    to, the batch's `storedCandidates`, the resolved batch with its plan, and the `mentionLinkOptions` the rows' mention selects offer), the
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
  - `use-stored-candidates.ts` — `useStoredCandidates(batchId, resources)`
    finds the stored candidates of the batch's first decode once per batch
    (`StoredCandidates.find`, one `ResourceMatch.findCandidates`). It is a TanStack
    query keyed by the batch id, and gives them as an `Option`, `None` until
    they are in and when the match failed. `useLinkChoiceReview` passes each
    referent's own resource first, then every decoded row's resource. It
    derives each referent's default beside the query
    (`ReferentMatch.defaultChoices`, over `StoredCandidates.empty` until they
    are in, so every referent takes `CreateResource`),
    and labels the stored resources the defaults link to or update
    (`LinkChoice.storedResourceOf`).
  - `use-reviewer-link-choices.ts` — `useReviewerLinkChoices` keeps the
    reviewer's choices on top of the defaults by `Referent.key` across a
    settings re-decode in a `ReferentLinkChoiceSet`, their link choice set
    by mention beside it in a `MentionLinkChoiceSet` (by
    `MentionLinkChoiceSet.key`, set by `chooseMention`), and the referents and
    resources of the batch's first decode (`FirstDecode`), which the match
    reads. A fresh pick starts over.
  - `use-last-resolved-batch.ts` — `useLastResolvedBatch`, the batch's last
    resolving that succeeded, which a refusal is shown over.

  The referent block, "People and providers in this import", is one file
  per job:
  - `referent-rows.tsx` — the block the panel renders above the format
    groups (its `referentRows` slot): a tally of the records the referents
    are linked to (`ReferentTally`: a stored record, or one this import
    writes, is counted once however many referents share it), then one
    group per `LinkableLogicalReference.RESOURCE_TYPES`
    entry that has referents. A list that failed is said under its group,
    and only the search's hits are offered; a list the page limit cut off is
    said too. While the batch is `refused` the selects are disabled, since a
    choice could neither be resolved nor shown.
  - `referent-row.tsx` — one referent's line, memoised: its label, a select
    of its options, and its warning.
  - `link-choice-options.ts` — the `LinkChoiceOptions` view model: the
    options a referent's select offers, in two groups: `New`, or an update of
    the stored copy under its own id when one is known
    (`UpdateStoredResource`, a re-import's default), then the stored
    resources of its type **On the server**. A prescriber or provider the
    import implied is a referent like any other, so it offers the same.
  - `referent-line.ts` — the `ReferentLine` namespace: a group's lines (a
    referent, its choice, its options, its warning), each built once per
    change of what it is built from (its own choice and the stored list) and
    kept
    across every other change, so a select change rebuilds the lines it
    changed and the memoised rows of the others skip their render. The
    warning is `DifferingDemographics`: a Patient linked to a stored one
    whose family name, given name or birth date (`Patient.demographics`)
    differs gets a
    warning line, never a block; a Practitioner has nothing compared.
  - `use-referent-group-lines.ts` — `useReferentGroupLines`, the group's
    React side: the stored options as one memo per group, shared by its
    lines, and the built lines kept in state across renders.
  - `use-stored-resources-of-type.ts` — `useStoredResourcesOfType`: the
    server's own stored resources, every page read up front
    (`POST <Type>/_search` through `fhir-r4/clients`' `searchPagesOfType`, capped at
    ten pages: a select has no room for a load-more action, and a personal
    server holds a household, not a hospital), each labelled on the way in
    since `LinkableResource.labelOf` reads the clock. The read starts beside
    the batch's match: `usePrefetchStoredResources` observes the same query,
    `storedResourcesQuery`, for each referent type through `useQueries`, as
    soon as the batch's referents are known. It is never stale on its own. A
    confirm invalidates it, the one thing that changes it.
  - `referent-text.ts` — the block's strings, which say "server", never
    "device": the importer can be pointed at any FHIR server.

- **`src/run/`** — **Not mounted, awaiting #1466.** The two hooks that drive the old review's halves, held apart from
  the view they feed: the read (`use-import-run.ts`) and the opt-in write
  (`use-confirm-import.ts`). The confirm hook is the write half and does not
  belong under `preview/`.
  `use-import-run.ts` is React state around `importer-core`: `run` calls
  `readBatch` (through `useRunAuthed`) over the whole pick and holds the
  resulting `DecodedBatch`, `applySettings` calls `redecodeFormat` for the
  one format whose settings changed — from the `PickedFile`s that format's
  group holds (`files`), keeping every id and review key, so keyed selections keep
  applying — and it owns the `FormatSettings` record, the `batchId` that tells
  a fresh pick from a re-decode, and the in-flight ticket that drops a stale
  result. It imports the registry rather than taking it as a parameter, so its
  dependency arrays say what they mean. It provides the read's
  `DecodeRequirements` there, `positioned-text-web`'s
  `positionedTextExtractorPdfjs` for the LifeLabs decode. Grouping, decoding,
  and folding outcomes all happen in the core.
- **`src/preview/`** — **Not mounted, awaiting #1466.** The old review's view and the state it needs.
  `use-server-diff.ts` pre-classifies every previewed resource against its
  stored copy (`new` / `unchanged` / `changed`) for the row badges and the "already
  there, so out by default" rule (`unchangedKeysOf`), keyed **by review group and then by resource
  key** (`GroupComparisons`, over `importer-core`'s `ReviewGroup`) — two
  formats can carry the same resource key, so
  a flat map would let one format's verdict overwrite another's. Within one
  format the keys are already distinct, because the import stage
  (`DecodedFileSet.adopt`) namespaces each file set's keys by its first picked
  file's slot in the batch. A resource's stored copy is the stored resource
  its identifiers name, read off the batch's stored candidates
  (`StoredCopy.of`) without a request. It is compared by content with its
  `id` dropped (`compareWithStoredCopy`), so a copy stored under another id
  still reads `unchanged`. The write still goes to the resource's own id. A
  resource whose stored copy is `None` is compared with the copy under its
  own id, and so is every resource when the match failed. So a stored copy
  whose identifiers were edited reads `changed`, not `new`. Every such
  resource goes in one `POST /` batch of GETs (`classifyAgainstServer`),
  sent only when there is one. The screen blocks the
  first paint on it but **not** on the re-classification a settings change or
  a link choice triggers, since unmounting the panel mid-review would drop the
  focus of whatever control the reviewer is using; the verdicts the batch last
  settled on stay on screen (`refreshing`), a failed classification having
  settled on "every id is new", and the confirm waits for the new ones, since
  the defaults are read off them. A failed classification is retried
  twice before it is reported; a fresh pick carries nothing over.
  `preview-panel.tsx` renders the batch grouped by format — one group per
  format that has a group (`ReviewGroup.entries`), its settings form (the registry's own
  `SettingsPicker`, indexed by the format tag, in its box; neither for a
  format with no picker) over that format's sectioned,
  per-resource review — then the batch's **linked records** (the linked
  records' group, `ReviewGroup.LINKED`, the records it names but holds no
  copy of, as the referent rows link them)
  read-only with their diff badge and no toggle or edit, under one shared
  confirm, gated on the batch writing at least one resource. The panel's
  counts come off `importer-core`'s `planWrite`, the plan the confirm
  submits: the confirm names the `Included` decisions, one per `Type/id`,
  and the `Excluded` ones. Which linked records are written is that plan's
  too, not a toggle: none the server holds unchanged (`Unchanged`; the
  screen hands the panel and the confirm the same `unchangedLinked`, the
  linked group's `unchangedKeysOf`); otherwise every stored copy,
  whatever the reviewer excluded, since the link choice is the consent to
  it. The diff keys its verdicts by
  `importer-core`'s `ReviewGroup.Key`, a format or `ReviewGroup.LINKED`, so the linked
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
  batch's `decoded`, a format's own source file never),
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
  override shows and writes the override resolved on the plan
  (`StagedImport.resolvedResourceOf`), so the pick, and any later link of a
  referent it names, moves it too. Whether a row is included is the
  reviewer's tick, else the screen's default, so a patient picked for a
  resource without one takes it in, Don't link leaves it out again, and
  Revert leaves one out again when the resolved resource has no patient
  either, unless the reviewer ticked or unticked it themselves.
  `plan/describe-resource.ts` reads a decoded resource in its wire form and
  names its subject by the label of the resource it is redirected to, else
  its `display`, never by its `Patient/<id>`. A section's tri-state heading toggle is
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
  resource — no id locking, no provenance stamping — because the import stage
  already minted the source file and stamped every extracted
  resource's `meta.source`. The transaction lands whole or not at all, so a
  rejected entry refuses the batch and every entry reports the one cause;
  there is no separate upload step to fail.
  `resource-editor.tsx` (+ `resource-editor-helpers.ts`) is the inline JSON
  editor: **Keep** parses the text, decodes through
  `Schema.decodeUnknown(FhirResourceSchema)`, and refuses the edit unless it
  parses and preserves `resourceType` / `id`; `plan/describe-resource.ts`
  is the pure one-line summary per resource type.
- **`src/results/`** — **Not mounted, awaiting #1466.** The old review's outcome. `import-outcome.ts` is the pure fold: the
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
- **The source file is a record of the plan the import stage minted.**
  Every pick's source file `DocumentReference` is minted by `importer-core`'s
  import stage, which `readBatchCopies` runs over every format's `decode`,
  under that format's constants, and is its file set's first copy, keyed
  `<pick id>/source-file/<fileName>`. The shell neither mints it nor keys it,
  and dispatches on no format tag to get it: the plan suggests a choice for it
  like any other record. Its id is deterministic in the file, so the
  `meta.source` links survive a re-read, and a file re-picked off the server
  mints the source file it came from, which the plan links to rather than
  writes again. The source-file list query is invalidated after every write
  that was sent (a fresh source file is a new `DocumentReference` the picker
  should see next pick).

## Traps

- **The read half writes nothing, and the split is the whole product.**
  Reaching the import plan issues no writes — `decode` requires no client,
  only the PDF extractor, and planning only searches and reads the store —
  and Import writes exactly the resolution on screen (`ImportWrite.of`) with
  no re-parse. A test pins this on the wire (no writes to reach the plan, and
  the reads are the source list, one identifier search per type and one batch
  reading what is stored under the ids the import would write); do not add a
  write to the read path (e.g. an "auto-upload on pick") that would collapse
  the opt-in seam.
- **`resolvePlan` is impure, so it runs in actions, never in render.** It
  reads the clock and mints ids, so a render or a `setState` updater must not
  call it: every action that produces a plan resolves it in its handler or
  continuation and commits the plan and its resolution together, and the
  write sends exactly the resolution committed.
- **The write lands whole or not at all, and a failed write keeps the
  plan.** The plan is one `transaction` bundle, which the server lands every
  entry of or none (`fhir-r4-rust`'s `batch_bundle_at_base.rs` pins HFS doing
  so). `persistTransactionBundle`'s error channel is `never`, so a refusal is
  every entry's outcome failing under the one cause, not a raised error: the
  page goes back to `Reviewing` with `WriteFailure.Refused`, and the plan and
  its resolution as they were, so Import can be pressed again. An outcome of
  `NO_RESPONSE_STATUS` means no readable answer came back, so the
  transaction may have landed: that, and a run that failed outright, is
  `Unanswered`, and the page says it is not known whether the records were
  written. Nothing offers a way off the page while the write is in flight,
  since it lands whatever the page shows.
- **`ServerSourceFileList` never writes.** The list is a search, a selection is
  a `DocumentReference` GET, and a preview is the same GET plus a bytes
  render. It is exported into the anonymizer shell's `serverSource` slot
  precisely because it is read-only; do not add a write to it — the preview
  modal is deliberately not editable, either.
- **Selection state lives in the screen, not the panel.** **Not mounted, awaiting #1466.** `PreviewPanel` is
  controlled — the screen passes `selectionFor` in and receives every change
  via `onSelectionChange`, holding the canonical
  `Map<FormatKind, Selection>` so it can hand the confirm the exact selection
  each format was reviewed with (`planWrite` reads each format's own
  decoded sections under it). Same for
  settings: the panel renders `settings` and reports `onSettingsChange`;
  `useImportRun` owns the record and the re-decode. Don't move either down
  into the panel, or the shell and the view can disagree.
- **The confirm is one `persistTransactionBundle`, and nothing is stamped at
  confirm.** **Not mounted, awaiting #1466.** `planWrite` (in `importer-core`) turns the formats' decoded
  sections plus the reviewer's selections, and the batch's linked records,
  into a **`WriteDecision`** per reviewed resource — `Included`, `Excluded`,
  `Unchanged`, `Unreferenced` or `Superseded` — a set leading with its
  source files in the same bundle as its
  extracted resources, no upload-then-persist sequence and no ordering to
  protect. `importBatch` hands the `Included` decisions' resources, in the
  plan's order, to one `persistTransactionBundle`: it does not look for the
  source file, lock an id, or write `meta.source`, because the import stage
  already minted the source file at a deterministic id and stamped
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
  **Not mounted, awaiting #1466.**
  The batch is resolved as one: a format's resources point at the linked records
  and at referents another format holds, so a server holding half of it would
  hold references to records it does not. One `transaction` bundle, which
  the server lands every entry of or none (`fhir-r4-rust`'s
  `batch_bundle_at_base.rs` pins HFS doing so), rather than one `batch` per
  format. `persistTransactionBundle`'s error channel is `never`, so a refusal
  is every entry's outcome under the one cause, not a raised error. A claimed
  format with no `Included` decision (nothing in it decoded to a resource, the
  reviewer left every row out, or every file unreadable; `skipReasonFor` says
  which) is `skipped`, never a failure, and never reaches the bundle.
  `isPartialBatch` lifts `collectImportSummary` to the batch: any rejected
  resource, a linked record included, makes it partial, and `import-results.tsx`
  frames a batch nothing of which wrote as failed; a `skipped` format alone does
  neither. There is **no** whole-flow `errored` state and no `uploadFailed`
  result — a refused batch is its rows in the results, their cause the server's
  own response.
- **The confirm affordance is gated on the batch having a resource to
  write.** **Not mounted, awaiting #1466.** `PreviewPanel` shows the single confirm button only when
  `planWrite`'s plan — over the **claimed** formats' rows and the linked
  records — has an `Included` decision; unreadable
  files and formats whose decode yielded nothing render their own section but
  add nothing to write, a linked record the server holds unchanged, or a
  new one no included resource names, adds nothing either, and two rows
  under one `Type/id` count once, the earlier `Superseded`. A changed stored
  copy alone is something to write, so the confirm can be offered with every
  format's resources excluded; the results then say no file's resources
  were imported. The confirm reads the same
  plan, so the count and the write cannot disagree, and both walk the
  batch's groups (`ReviewGroup.entries`): a format took part exactly when it
  has a group, so a format that claimed nothing is not planned, tallied, or
  reported.
- **The source file list is format-blind and disjoint from web traces on the
  same axis.** The list searches `category` for `SOURCE_FILES_CATEGORY_TOKEN` —
  the comma-joined `system|code` tokens of every registered format's
  source file coding (`WEB_TRACE_CODE_SYSTEM|har-archive` for HAR, the LifeLabs and DICOM
  systems for theirs), built at module
  load from `PickedFile.categoryToken` over each format's `sourceFileFormat`,
  so it cannot drift from what the mint writes. It is one
  `fhir-r4-react/smart` `fetchDocumentReferencePage` read per page, run on the
  page's SMART runtime (`useRunSmart`), each later page the previous bundle's
  `next` link verbatim. Each returned resource is
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
  `_cursor=` as token-less.** `''` is not `null`, so TanStack Query would
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
  `sourceFileFormat` provided as the `PickedFile.Format` service, as
  `importer-core`'s import stage (`importDecoded`) provides it to build each
  pick's source file — so a
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
  The import stage's mint derives the resource id with `localResourceId` over the file's SHA-256 and
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
- **The source-file list runs on the page's SMART runtime, one way.**
  `useSourceFilesQuery`, the picker's row-select, and the preview modal's
  fetch all read `useRunSmart()` (`SmartRuntimeContext`, which
  `SmartHandshakeGate` provides), since the listing's next-link read needs
  `SmartClient`, which the router context's `useRunAuthed()` runner is not
  typed to provide; the query also exposes
  `sourceFilesInfiniteQueryOptions(runSmart)` taking the runner, for a test
  that drives the query itself. The rest of the slice reads
  `useRunAuthed()`. There is no prop-threaded way in.

## Testing

Property-based where there is an invariant, example-based where there is a
behaviour to document — see
[Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
and [React Testing Reference](../../../docs/Testing/React%20Testing%20Reference.md).
Use the workspace-local `node_modules/.bin/vp` for jsdom runs.

- `sources/source-picker.test.tsx` mocks only the two runner seams
  (`useRunAuthed` and `fhir-r4-react/smart`'s `useRunSmart`), both one real
  SMART runtime, and drives the whole picker over
  a stub `HttpClient`; the runner is built through `fhir-r4-react/smart`'s
  `buildSmartRouterContext` so a bearer token rides the wire and the test can
  assert `Authorization: Bearer …` and the search URL against the recorded
  requests. The three-paths test synthesizes a `DataTransfer` for the drop,
  uploads to the hidden input for the pick, and clicks a row for the server source;
  the server source file fixtures are hand-built `DocumentReference` JSON with base64
  `data` so a `Uint8Array` from jsdom's realm never has to satisfy the codec's
  `instanceof` check.
- `importer-screen.test.tsx` is the end-to-end one: it replaces only the router
  seam and drives the whole flow over the recording stub FHIR server in
  `screen-server.test-helpers.ts`, reading one ordered request log back. It
  pins the opt-in seam (no writes to reach the plan, and only searches and
  reads), the summary of a capture, Import as one transaction holding every
  record and its source file (each record's `meta.source` naming it), the
  complete notice, a refused transaction keeping the plan and Import pressed
  again, a re-import with nothing to import and no Import button, a source
  file re-picked off the server linked rather than written, a Patient two
  stored records carry the identifier of left open and blocking Import, the
  Needs a decision cards (a capture of one person off a second FHIR server,
  `screen-fixtures.ts`' `tyraBanksHar` over `SERVER_A` and `SERVER_B`,
  offered the stored Patient already selected and written as one Patient
  carrying both servers' identifiers that both subjects name; two stored
  namesakes left not selected, blocking Import, with Go to record focusing
  the card's first radio, and each of the namesake chosen, Save as a new
  record and Don't add written as chosen; the update checkbox partly
  checked, then taking every field, then none; every control of a card
  disabled while a held transaction is in flight; a refused write still
  said after a choice, and gone once Import lands), the Decided
  automatically rows (a re-import with every row folded behind "N same as
  existing", each tagged the same as existing once shown, nothing written;
  a person changed to Don't add, its Changed chip, the counts moving, its
  referrers' detail "(display only)", and Reset; a group's Don't add any,
  Reset to suggested, and Create all writing new records; an identifier
  match whose field differs, its update selected and written; a folded
  row's select keeping focus when it is changed, and getting it back on
  Reset; every select and menu disabled while a held transaction is in
  flight), the
  red lines of an unreadable and an unrecognised file with no record read
  from either, the loader card while a read is in flight, a failed search,
  a runner that rejects the read, no way to
  leave while a held transaction is in flight, cancel, and a batch of
  several files with a DICOM study among them. It
  re-wraps `TextEncoder` output through the ambient `Uint8Array` (a jsdom
  single-realm workaround; the production encode stays `new
  TextEncoder().encode(text)`). The stub server holds what it is seeded with
  and what is written to it, and answers identifier searches, the name
  stage's `birthdate` and `name` searches (as HFS does: any of the dates; a
  name part starting with any of the words, case and accents folded), paged
  lists and batch reads from that; it refuses a `transaction` one of whose
  entries fails as a whole, as HFS does, fails every typed search when told
  to, and holds a transaction's answer until a promise it is given settles.
  It reads a `POST`ed body with `tryParseBundle`, a Schema decode that is
  `None` for a body that is not a Bundle, so a non-bundle `POST /` falls
  through to the other routes.
- `plan/plan-text.test.ts` pins the page's sentences as whole values (both
  write failures' among them), and as a property that a file set's line
  leaves out exactly its zero parts and its parts sum to its records; `plan/record-text.test.ts` pins a record's
  and a stored resource's title in a sentence and the identity fields it
  states; `plan/field-value-text.test.ts` pins each field's text, and as
  properties that a scalar reads as itself and a value of no common shape as
  compact JSON cut short at 80 characters, and the two sides of a difference
  that would read alike shown as JSON;
  `plan/plan-differences.test.ts` pins a record's candidates (a second
  record into one existing record compared with it as the first's merge
  leaves it, a record that needs no decision compared too, none for one
  with no existing record) and what is read off them (a field taken that
  no longer differs counting for nothing); `plan/plan-sections.test.ts`
  pins as properties over arbitrary plans (records two file sets bring,
  implied copies, records not needed, identifier matches whose suggestion
  fills gaps) that every record that needs no decision is in exactly one
  group and none that needs one is, that the people's section holds
  exactly the Patients and Practitioners and each file set's section its
  own records, and that changed rows come first and the fold holds exactly
  the unchanged identifier matches with nothing to merge, and as examples
  the order by label and the pages; `plan/reason-tag.test.ts` and
  `plan/row-text.test.ts` pin the tags, titles and details whole (a
  reference to a record with no choice yet titled by that record);
  `plan/row-options.test.ts` pins the option each choice selects, ", updated"
  exactly when the merge an option stands for takes a current difference,
  and an option's merge filling that candidate's gaps;
  `plan/record-group.test.tsx` sets every record of a group from its menu,
  the rows not shown and those folded included;
  `plan/plan-record-row.test.tsx` renders a row suggested new, an
  identifier match's update, and a changed row reset;
  `plan/decision-card.test.tsx` renders a
  card not selected, with an existing record selected, with Don't add
  selected, and for a record several existing records carry the identifier
  of. They build
  records and plans with `plan/plan.test-helpers.ts`.
- **Not mounted, awaiting #1466.** `identity/referent-rows.test.tsx` drives `useLinkChoiceReview` and the rows over a
  hand-built batch and a stub server answering the identifier searches, the
  name stage's `birthdate` and `name` searches as HFS does, and the stored
  list (one that continues for ever, cut off by the page limit): a line per referent, people before
  providers, `New` without a hit, a hit pre-selected, an update over the copy
  found under the decoded id, the demographics warning,
  and a changed select resolving the batch.
- **Not mounted, awaiting #1466.** `preview/format-review-body.test.tsx` drives one format's body over its
  rows resolved on the identity map: Needs a patient only when a subject is
  unlinked, a pick that is a mention link choice and includes the row, Don't
  link leaving it out again, a pick following its referent's later link,
  where Don't link is offered, an edit override resolved on the plan (a
  pick, or a later link of the patient it names, moves it), Revert leaving
  a row without a patient out again, an untouched row taken back in when its
  patient is linked, and a ticked row kept in.
  `identity/mention-link-options.test.ts` pins what a select offers: the
  plan's resolved resources, a record two referents are linked to once, as
  the choice of the referent whose record it is.
- **Not mounted, awaiting #1466.** `preview/preview-panel.test.tsx` drives the pure panel by props — no router —
  and pins that a claimed format renders each decoded section under its own
  title with per-resource checkboxes, that an unreadable file renders its own
  alert, that a mixed batch sums to one confirm over every claimed format's
  sections, that two rows under one `Type/id` count once, that each
  format with settings mounts its own settings picker in its box while HAR
  renders no settings form, and that the confirm
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
- [slices AGENTS.md](../../../slices/AGENTS.md) — the slice layering rules this package
  follows.
- [web-trace-core AGENTS.md](../../../slices/web-trace-core/AGENTS.md) — the
  coding a HAR source file shares an axis with, and the disjointness of traces
  and source files (a test-fixture dependency here, nothing at runtime).
- [fhir AGENTS.md](../../../slices/fhir/AGENTS.md) — `fhir-r4`'s typed client and
  `fhir-r4-react`'s SMART runtime and authed runner.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
