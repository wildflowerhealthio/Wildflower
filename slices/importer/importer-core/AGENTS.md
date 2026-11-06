# AGENTS.md — slices/importer/importer-core

The **pure core** of the importer slice: the closed format registry and the
batch machinery a shell drives. It sits between the format bindings
(`har-importer-core`, `lifelabs-pdf-importer-core`, `dicom-importer-core`) and
the React shell (`importer-react`), which adds each format's `SettingsPicker`
(for a format that has settings) to the registry here and runs these functions
from its hooks.

No DOM, no `fs`, no React, no client: every export is a value or an Effect
whose only requirement is **`DecodeRequirements`**, what the registered
formats' decodes need to read their bytes (LifeLabs' `PositionedTextExtractor`).
A headless host could run an import to the point of a write plan with this
package alone and a layer that provides those.

## Shape

- `src/registry.ts` — the closed, compile-time **`formatRegistry`**:
  `{ har, 'lifelabs-pdf', dicom }`, each entry the format's `FileImporter`,
  checked with `satisfies` so per-format concrete types survive without casts
  and a format missing a field fails to compile here. **`FormatRequirements`**
  (internal) reads what each entry's decode requires back off it (`never` for HAR and
  DICOM, `PositionedTextExtractor` for LifeLabs), **`DecodeRequirements`** is
  their union, and **`BoundFormat<K>`** is one format's importer with its own
  settings, tag and requirement.
  **`FormatSettings`** is the per-format settings record and the source of
  truth, `null` for a format with no settings (HAR) — **`FormatKind`** is its
  key union, **`defaultFormatSettings`** the seed a fresh import starts from,
  and **`formatKinds`** the typed registry-order walk, _derived_ from
  `formatRegistry` rather than listed, because a hand-written
  `readonly FormatKind[]` was the one slot a missing format could slip through silently.
  `defaultFormatSettings`, by contrast, is written out per format on purpose:
  `Object.fromEntries` erases the key-to-value correlation the record's type
  states, so a derived version needs an `as FormatSettings` and checks nothing,
  while the literal makes a missing format a compile error. Adding a format is
  one `FormatSettings` entry, one registry entry, one default — and
  `collectFormats` below, which `resolveMentions` also assembles its batch
  through. All four are mapped or exhaustive types over `FormatKind`, so missing
  any of them is a compile error.
- `src/import-decoded.ts` — **the import stage**, the one place a record is
  made the device's own, a source file is minted and `meta.source` is
  stamped. **`importDecoded(importer, decoded)`** takes one format's
  `FormatDecode.Decoded` and the **`ImportingFormat`** it reads off the
  format's importer (`sourceFileFormat`, `linkSourceFile`,
  `linkToSourceFiles`), and returns its `FormatDecode.Result`, never failing.
  Per file set it mints a source file for **every** picked file
  (`Schema.encode(PickedFile.FromDocumentReference)`), its `masterIdentifier`
  what the picked file identified itself as; adopts its detached records with
  `DecodedFileSet.adopt` (a keyed record under the id its key derives, a
  keyless one under a random id, the records the set's references name and
  none of its records is implied, each logical reference to a record of the
  set resolved to a literal one); runs `linkSourceFile` over each source file with the
  set's adopted records, then `linkToSourceFiles` over every record with each
  picked file and its linked source file; stamps every record's `meta.source`
  with the set's **representative** — the picked file whose source file id is
  lexicographically smallest, and a source file id is a content hash, so the
  stamp is independent of the order the files were picked in
  (`MetaSource.stampDecoded`) — and prepends the source files as the set's
  **"Source file"** / **"Source files"** section. Nothing is de-duplicated
  across sets or files: each set's records are kept and keyed as they are. A
  set whose source file cannot be minted, or whose `linkToSourceFiles` fails
  with `FileImporter.SourceFileNotFound`, becomes one `unreadableFiles` row per
  picked file, after the decode's own. It provides `PickedFile.Format`
  internally, so what it returns requires nothing.
- `src/read-batch.ts` — the read half as pure functions over a
  **`ReadRegistry<R>`** (`format`, `detect` and `decode` of each format's
  `FileImporter`, its decodes requiring `R`, and the `sourceFileFormat`,
  `linkSourceFile` and `linkToSourceFiles` the import stage reads — deliberately not the whole
  `BoundFormat`, so a test can stand up a fake registry with just those
  fields). `readBatch` and `redecodeFormat` require the `R` of the registry
  they are handed: `DecodeRequirements` for `formatRegistry`, `never` for a
  fake whose decodes read their bytes themselves. **`readBatch`** takes the picker's
  `PickedFile.NamedBytes`, groups them by format
  and decodes every group concurrently into a **`DecodedBatch`**: its
  `formats`, a **`FormatResults`** record of one `FormatDecode.Result<K>` per
  registered format (an `emptyResult` for a format that claimed nothing),
  and its `unrecognizedFiles`, the **`UnrecognizedFile`**s, plain data for the
  picks no `detect` claimed. Every format's decode goes through
  `importDecoded` in `decodeFormat`, so a batch read or re-decoded is always
  imported. The format slots are a field of their own rather
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
  per-format `Match` branch, then the import stage) — are module-level exports for this package's own
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
  holding the resolved file, plus its **`linkedRecords`** (the resolved
  records no resolved file holds, written beside the files, no format's), **`plan`** (the
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
  format-then-review order.
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
  resolved records no resolved file holds (`FileResolution.linkedRecords`), and `plan`, so
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
  choice to its searched default, a default to
  `ReferentLinkChoiceSet.DEFAULT_CHOICE` (`ReferentLinkChoiceSet.remove`); a failure
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
  order. It adds no provenance and rewrites nothing: the import stage already
  minted the source file and stamped `meta.source`. The five
  dispositions, in the order they are decided:
  - **`Excluded`** — a format row that is not included: the reviewer
    unticked it, or never ticked one `excludedByDefaultFor` leaves out.
    Every other format row is a candidate.
  - **`Unchanged`** — a linked record the server holds as it is (its key in
    `unchangedLinked`, the server diff's `unchanged`). Any other linked
    record — a resolved record no file holds, the batch's identifiers
    assumed — is a candidate whatever the reviewer excluded, the link choice
    being the consent to it, so a batch can write it and no format's
    resources.
  - **`Unreferenced`** — a format row the import implied
    (its `origin` is `Implied`) that no candidate format row
    names by its literal `Type/<id>` (`Mention.madeIn`): written alone it
    would be an orphan.
  - **`Superseded`** — a candidate a later candidate shares its `Type/id`
    with, or an implied candidate (its `origin`) a decoded one shares its
    `Type/id` with, whatever their order: a record a file decoded says more
    than one a reference implied.
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
`importer-react` and by `apps/synthetic-data`, which imports what it generates
through the same stage. Imports no `*-importer-react` and no `web-trace-core`.

## Guardrails

- **Source files are minted here, and decided by each format.** What a source
  file is, which resources point at it, and what happens to those links when
  the reviewer excludes it are each format's decisions, stated on its importer
  (`sourceFileFormat`, `linkSourceFile`, `linkToSourceFiles`); the import stage only runs
  them. `planWrite` treats the source file row as any other resource. Do not
  reintroduce a shell-side mint, a side map of source files, or a "primary
  file".
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
