# AGENTS.md — slices/importer/importer-core

The **pure core** of the importer slice: the closed format registry and the
batch machinery a shell drives. It sits between the format bindings
(`har-importer-core`, `lifelabs-pdf-importer`, `dicom-importer-core`) and
the React shell (`importer-react`), which adds each format's `SettingsPicker`
to the registry here and runs these functions from its hooks.

No DOM, no `fs`, no React, no client: every export is a value or a
service-free Effect. A headless host could run an import to the point of a
write plan with this package alone.

## Shape

- `src/registry.ts` — the closed, compile-time **`formatRegistry`**:
  `{ har, 'lifelabs-pdf', dicom }`, each entry the format's `FileImporter`
  typed as a **`BoundFormat<K>`**, so per-format concrete types survive
  without casts and a format missing a field fails to compile here.
  **`FormatSettings`** is the per-format settings record and the source of
  truth — **`FormatKind`** is its key union, **`defaultFormatSettings`** the
  seed a fresh import starts from, and **`formatKinds`** the typed
  registry-order walk, _derived_ from `formatRegistry` rather than listed,
  because a hand-written `readonly FormatKind[]` was the one slot a missing
  format could slip through silently. `defaultFormatSettings`, by contrast, is
  written out per format on purpose: `Object.fromEntries` erases the
  key-to-value correlation the record's type states, so a derived version needs
  an `as FormatSettings` and checks nothing, while the literal makes a missing
  format a compile error. Adding a format is one `FormatSettings`
  entry, one registry entry, one default — and `collectFormats` below, which
  `resolveMentions` also assembles its batch through. All four are
  mapped or exhaustive types over `FormatKind`, so missing any of them is a
  compile error.
- `src/read-batch.ts` — the read half as pure functions over a
  **`ReadRegistry`** (`Pick<BoundFormat<K>, 'format' | 'detect' | 'decode'>` per
  format — deliberately not the whole `BoundFormat`, so a test can stand up a
  fake registry with just those fields). **`readBatch`** takes the picker's
  `PickedFile.NamedBytes`, groups them by format
  and decodes every group concurrently into a **`DecodedBatch`**: its
  `formats`, a **`FormatResults`** record of one `FormatDecode.Result<K>` per
  registered format (an `emptyResult` for a format that claimed nothing),
  and its `unrecognizedFiles`, the **`UnrecognizedFile`**s, plain data for the
  picks no `detect` claimed. The format slots are a field of their own rather
  than spread beside `unrecognizedFiles`, so `batch.formats[kind]` under a
  generic `K` is that format's own `Result<K>`. A decoded batch holds no
  linked records and no link targets; **`claimedFormats`** takes the
  `FormatResults` (`batch.formats`) and names the formats that actually took
  part, the one predicate the preview and the confirm both read;
  **`redecodeFormat`** re-runs one format's files from their retained picks
  under new settings (ids are deterministic, so no id-preservation logic is
  needed).
  **`groupByFormat` is the one place a pick's id is minted** — its position in
  the whole batch and its file name, so two `report.pdf`s out of two folders
  stay distinct and a settings re-decode, which hands the same files back,
  yields the same ids. Nothing above or below it mints one: a picker source
  produces `NamedBytes`.
  Its three internal steps — `identifyPick` (the first claiming detector, via
  `FormatDetector.claiming`), `groupByFormat`, and `decodeFormat` (generic in
  `K` so `registry[kind]` and `settings[kind]` stay correlated with no
  per-format `Match` branch) — are module-level exports for this package's own
  tests and are **not** re-exported from `index.ts`: the shell drives the whole
  read, never a leg of it.
  **`collectFormats`** is the one place the registry is enumerated by name,
  and its remarks say why: TypeScript drops the correlation between a computed
  union key and its value, so a record assembled from a `kind` variable is
  checked against nothing. It yields a **`FormatResults`**, which each caller
  places in its batch.
- `src/resolve-mentions.ts` — a batch's mentions resolved (a resolved batch
  is one whose mentions are resolved), service-free Effects on the clock. The
  batch goes from **decoded** (`DecodedBatch`, as `readBatch` read it) to
  **resolved** (`ResolvedBatch`, every link followed, as it will be written)
  against what is **stored** on the device, the identity map's three states
  (`importer-fundamentals`' AGENTS).
  **`ResolvedBatch`** is a decoded batch, each format slot's `decoded`
  holding the resolved file, plus its **`linkedRecords`** (the resources it
  only mentions, written beside the files, no format's), **`plan`** (the
  `LinkPlan` it was resolved on, which the referent rows ask each referent's
  link target of, and the review asks what its referent links leave
  unlinked, `UnlinkedMention.leftByReferentLinks`) and **`decodedBatch`**
  (the batch as decoded, whose rows that question is asked of, since a
  resolved row also carries the mention links). **`isSourceFileOf(kind,
  resource)`** says whether a resource is a format's own source file, which
  the review never asks a patient for.
  Only `resolveMentions` makes one, and the diff, the preview and the confirm
  take nothing else.
  **`discoverReferents(batch)`** is `Referent.discover` over every claimed
  format's `decoded`: one referent per identity across formats,
  format-then-review order, those with a resource first.
  **`resolveMentions(batch, linkChoiceSet)`** (a `LinkChoiceSet`, by
  referent and by mention) resolves every mention in every
  claimed format's `decoded` on one plan over the batch's referents
  (`LinkPlan.make` once, over every claimed format's decoded file, the
  link choice set by mention laid on it with
  `LinkPlan.withMentionLinkChoiceSet`), resolving
  each format once, in its own slot (`resolveFormat`, over
  `FileResolution.resolveFile(plan)`), so a mention in one format
  links to a referent another holds, and a review key being unique across
  the batch, a mention link choice names one mention of one format's
  resource; it fills `linkedRecords` with the
  records the batch only mentions, each with its `origin`, `Stored` or
  `Provisional` (`FileResolution.linkedRecords`), so a
  stored person several formats mention is written once, and `plan`, so
  the screen's hook reads each referent's link target without planning
  again. Keys and section
  titles are kept; the format slots are reassembled through `collectFormats`,
  a slot nothing moved in coming back as it was, and a batch with no claimed
  format comes back with no linked records, an empty plan and nothing
  unlinked. It fails with
  `Referent.DuplicateReferent` or `LinkChoice.InvalidLinkChoice`, as the plan
  does; a mention link choice its mention cannot take is no choice, never a
  failure.
  **`resolveMentionsWithFallback(batch, defaults, chosen, byMention)`** is
  what the screen resolves: `resolveMentions` on the link choice set built
  from the reviewer's choices over the searched defaults
  (`ReferentLinkChoiceSet.union`) and their link choice set by mention, as
  `{ batch, linkChoices }`: the `ResolvedBatch` and the referent
  choices it was resolved on. A referent choice that
  cannot be resolved (`InvalidLinkChoice`) falls back: the reviewer's own
  choice to its searched default, a default to its kind's default
  (`ReferentLinkChoiceSet.remove`); a failure
  naming a referent with no choice dies. Its one failure is
  `Referent.DuplicateReferent`.
- `src/unlinked-mentions.ts` — what the referent links leave unlinked in a
  format's rows. **`leftUnlinkedIn(plan, kind)`** is a **`LeftUnlinked`**:
  `UnlinkedMention.leftByReferentLinks` on the plan, nothing for the format's
  own source file. **`isOfPatient`** says whether an unlinked mention is of
  the resource's patient (outside every compartment, or a dangling
  `subject`). **`keysWithoutPatientOf(batch, kind, selection)`** names the
  rows left without a patient as they will be written (each row's edit,
  else its resolved resource): the half of the review's default exclusion
  that is not the server diff. `importer-react`'s screen and the import
  golden pin in `synthetic-data-core-js` both read it, so a headless import
  with every default accepted excludes what the screen does.
- `src/review-group.ts` — **`ReviewGroup`**, the group a reviewed resource
  falls in: a `FormatKind`, or **`LINKED_GROUP`** for the batch's linked
  records, which no format holds. A resource key is unique within a group,
  not across groups, so the server diff, the preview and the write plan each
  scope a resource by its group.
- `src/plan-write.ts` — **`planWrite(batch, selectionFor,
  excludedByDefaultFor, unchangedLinked)`**,
  the pure half of the confirm: one **`WriteDecision`** per reviewed
  resource — its `ReviewGroup`, its `entry` as reviewed (the inline edit,
  resolved on the batch's plan, substituted), and its **`Disposition`** — in submit order: the linked
  records first, then each claimed format in registry order, rows in review
  order. It adds no provenance and rewrites nothing: the format's `decode`
  already minted the source file and stamped `meta.source`. The five
  dispositions, in the order they are decided:
  - **`Excluded`** — a format row that is not included: the reviewer
    unticked it, or never ticked one `excludedByDefaultFor` leaves out.
    Every other format row is a candidate.
  - **`Unchanged`** — a linked record the server holds as it is (its key in
    `unchangedLinked`, the server diff's `unchanged`).
  - **`Unreferenced`** — a linked record of `Provisional` origin, made from a
    mention alone, that no candidate format row names by its literal
    `Type/<id>` in any reference field (`Mention.madeIn`), so it is never an
    orphan. A changed linked record of `Stored` origin — a stored resource a
    link targets, the batch's identifiers assumed — is a candidate whatever
    the reviewer excluded, the link choice being the consent to it, so a
    batch can write stored copies and no format's resources.
  - **`Superseded`** — a candidate a later candidate shares its `Type/id`
    with.
  - **`Included`** — the last candidate under its `Type/id`: the transaction
    bundle keeps one entry per `Type/id`, the last occurrence, so the
    `Included` resources are exactly the bundle's entries and no row's edit
    is lost silently.

  It is the one place the rule for the linked records lives, since the review
  shows them read-only; the preview's counts and the confirm both read it.
  A claimed format with no `Included` decision writes nothing, and
  **`skipReasonFor(result)`** says why, a **`SkipReason`**: `unreadable` when
  its decode yielded no resources and some file was unreadable, else
  `nothing`.

## Layering

Depends on `importer-fundamentals` (the contract, `PickedFile`, `StagedImport`,
the identity map), the three `*-importer-core` bindings (the importers the
registry lists), `fhir-r4` (the `FhirResource` type), and `effect`. Depended on by
`importer-react`. Imports no `*-importer-react`, no `web-trace-core`, and
nothing from `slices/http-extraction`.

## Guardrails

- **No source file knowledge here.** What a source file is, which resources point at
  it, and what happens to those links when the reviewer excludes it
  are each format's decisions, made inside its `decode` by
  `importer-fundamentals`' `DecodeFunction.make`. `readBatch` and `planWrite`
  treat the source file row as any other resource. Do not reintroduce a
  shell-side mint, a side map of source files, or a "primary file".
- **Ids are deterministic via `FormatDecode.makeId`.** An id is derived from
  the format tag and the picked files' own ids — which `groupByFormat` mints
  from each file's position in the batch and its name, so two picks of the same
  name stay distinct — and a re-decode hands the same `files` array back, so
  the same ids come out and the reviewer's selection keeps applying.
- **`decode` never fails.** A malformed file is an `unreadableFiles` entry,
  folded by `DecodeFunction.make`; there is no `catchAll` in the read half, and a
  format that raised would be a contract bug, not a case to handle here.
- **Dispatch generically, not by `Match`.** Indexing the registry by a
  `FormatKind` union loses the per-format correlation; a generic
  `<K extends FormatKind>(kind: K)` helper keeps it. Add formats to the
  registry, never a branch to this package.

## References

- [slices/importer AGENTS.md](../../../slices/importer/AGENTS.md) — package roles and layering.
- [importer-fundamentals AGENTS.md](../../../slices/importer/importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract, the source file seam, and `StagedImport`.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  runs these functions from its hooks.
- [Adding a File-Format Importer How-To](../../../slices/importer/docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the registry edit a new format makes here.
