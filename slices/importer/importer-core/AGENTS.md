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
  and decodes every group concurrently into a **`DecodedBatch`** — one
  `FormatDecode.Result<K>` per registered format (an `emptyResult` for a format
  that claimed nothing) and the **`UnrecognizedFile`**s, plain data for the
  picks no `detect` claimed. A decoded batch holds no linked records and no
  links; **`claimedFormats`** reads only the format slots (`FormatResults`),
  so it takes a decoded or a resolved batch, and names the formats that
  actually took part, the one predicate the preview and the confirm both read;
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
  checked against nothing. Its slots are typed by **`FormatResults`**.
- `src/resolve-mentions.ts` — a batch's mentions resolved (a resolved batch
  is one whose mentions are resolved), service-free Effects on the clock. The
  batch goes from **decoded** (`DecodedBatch`, as `readBatch` read it) to
  **resolved** (`ResolvedBatch`, every link followed, as it will be written)
  against what is **stored** on the device, the identity map's three states
  (`importer-fundamentals`' AGENTS).
  **`ResolvedBatch`** is a decoded batch's slots plus the two a decoded batch
  cannot hold: its **`linked`** records (the resources it only mentions,
  the batch's own slot, no format's) and every referent's **`links`**. Only
  `resolveMentions` makes one, and the diff, the preview and the confirm
  take nothing else.
  **`discoverReferents(batch)`** is `Referent.discover` over every claimed
  format's `decoded`: one referent per identity across formats,
  format-then-review order, those with a resource first.
  **`resolveMentions(batch, linkChoices)`** resolves every mention in every
  claimed format's `decoded` on one plan over the batch's referents
  (`LinkPlan.make` once, over every claimed format's decoded file), resolving
  each format in its own slot (`FileResolution.resolveFile(plan)`), so a mention in one format
  links to a referent another holds; it fills the `linked` slot with the
  records the batch only mentions, each with its `origin`, `Stored` or
  `Provisional` (`FileResolution.linkedRecords`), so a
  stored person several formats mention is written once, and the `links`
  with the plan's, so the screen's hook reads each referent's link target
  without planning again. Keys and section titles are kept; the format slots
  are reassembled through `collectFormats`, a slot nothing moved in coming
  back as it was, and a batch with no claimed format comes back with no
  linked records and no links. It fails with
  `Referent.DuplicateReferent` or `LinkChoice.InvalidLinkChoice`, as the plan
  does.
  **`resolveMentionsWithFallback(batch, defaults, chosen)`** is what the
  screen resolves: `resolveMentions` on the reviewer's choices over the
  searched defaults (`ReferentLinkChoices.union`), as `{ batch, linkChoices }`: the `ResolvedBatch` and the
  choices it was resolved on. A choice that
  cannot be resolved (`InvalidLinkChoice`) falls back: the reviewer's own
  choice to its searched default, a default to its kind's default
  (`ReferentLinkChoices.remove`); a failure
  naming a referent with no choice dies. Its one failure is
  `Referent.DuplicateReferent`.
- `src/plan-write.ts` — **`planFormatWrite(result, selection)`**, the pure half
  of the confirm: from one format's decode result it produces a `write` of
  exactly the reviewed resources (exclusions applied, inline edits
  substituted, in review order) with the `excluded` count, or a `skip` with
  its **`SkipReason`** (`nothing` / `unreadable`). It adds no
  provenance and rewrites nothing: the format's `decode` already minted the
  source file and stamped `meta.source`.
  **`planBatchWrite(batch, selectionFor, unchangedLinked)`** is the whole
  resolved batch's plan, a **`BatchWritePlan`**: every claimed format's
  **`PlannedFormat`** (its result and `planFormatWrite`'s plan) and the
  `linked` records written beside them. It is the one place the rule for the
  linked records lives, since the review shows them read-only. None whose key
  is in `unchangedLinked` (the server diff's `unchanged`) is written.
  Otherwise a **stored copy** — a stored resource a link lands on
  (`LinkTarget.Stored`), the batch's identifiers assumed — is written whatever
  the reviewer excluded, the link choice being the consent to it; a **new**
  record — a provisional one — only when some resource a format writes
  references it by its literal `Type/<id>`, in any reference field
  (`Mention.madeIn`), so it is never an orphan. A batch can so write stored
  copies and no format's resources. The preview's count and the confirm both
  read it.

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
  `importer-fundamentals`' `DecodeFunction.make`. `readBatch` and `planFormatWrite`
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
