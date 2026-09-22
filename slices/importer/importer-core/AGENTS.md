# AGENTS.md — slices/importer/importer-core

The **pure core** of the importer slice: the closed format registry and the
batch machinery a shell drives. It sits between the format bindings
(`har-importer-core`, `lifelabs-pdf-importer-core`, `dicom-importer-core`) and
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
  entry, one registry entry, one default — and `collectFormats` below. All
  four are mapped or exhaustive types over `FormatKind`, so missing any of
  them is a compile error.
- `src/read-batch.ts` — the read half as pure functions over a
  **`ReadRegistry`** (`Pick<BoundFormat<K>, 'format' | 'detect' | 'decode'>` per
  format — deliberately not the whole `BoundFormat`, so a test can stand up a
  fake registry with just those fields). **`readBatch`** takes the picker's
  `PickedFile.NamedBytes`, groups them by format
  and decodes every group concurrently into a **`BatchDecodeResult`** — one
  `FormatDecode.Result<K>` per registered format (an `emptyResult` for a format
  that claimed nothing) plus the **`UnrecognizedFile`**s, plain data for the
  picks no `detect` claimed; **`claimedFormats`** names the formats that
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
  checked against nothing.
- `src/plan-write.ts` — **`planFormatWrite(result, selection)`**, the pure half
  of the confirm: from one format's decode result it produces a `write` of
  exactly the reviewed resources (exclusions applied, inline edits
  substituted, in review order) with the `excluded` count, or a `skip` with
  its **`SkipReason`** (`nothing` / `unreadable`). It adds no
  provenance and rewrites nothing: the format's `decode` already minted the
  source file and stamped `meta.source`.

## Layering

Depends on `importer-fundamentals` (the contract, `PickedFile`, `StagedImport`),
the three `*-importer-core` bindings (the importers the registry lists),
`fhir-r4` (the `FhirResource` type), and `effect`. Depended on by
`importer-react`. Imports no `*-importer-react`, no `web-trace-core`, and
nothing from `slices/collector` or `slices/http-extraction`.

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

- [slices/importer AGENTS.md](../AGENTS.md) — package roles and layering.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract, the source file seam, and `StagedImport`.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  runs these functions from its hooks.
- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the registry edit a new format makes here.
