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
  `{ har, 'lifelabs-pdf', dicom }`, each entry the format's
  `FileImporterDescriptor` typed through the **`FormatVariant`** type-level
  map (`settings` / `parsed` per format) as a **`BoundFormat<K>`**, so
  per-format concrete types survive without casts and a format missing a
  descriptor field fails to compile here. **`FormatKind`** is the key union,
  **`FormatSettings`** the per-format settings record, **`defaultFormatSettings`**
  the seed a fresh import starts from, and **`formatKinds`** the typed
  registry-order walk. Adding a format is one `FormatVariant` entry, one
  registry entry, one default, one kind.
- `src/unit-read-outcome.ts` — **`UnitReadOutcome`**, what one unit of a picked
  batch read to: **`ReadUnit<K>`** (a stable `id`, the format's `title`, the
  `files` it was decoded from, the `format` tag, and the `decoded` sections +
  notes — the format's own source-file `DocumentReference` already among
  them), **`UnreadableUnit<K>`** (the same identity plus the format's
  `ParseError`), or **`UnrecognizedFile`** (a pick no `detect` claimed).
- `src/read-batch.ts` — the read half as pure functions over a
  **`ReadRegistry`** (each format's `detect` + `decode`): **`groupByFormat`**
  splits a pick by the first claiming `detect`; **`decodeFormat`** runs one
  format's batch `decode` under its settings — generic in `K` so
  `registry[kind]` and `settings[kind]` stay correlated with no per-format
  `Match` branch; **`readBatch`** decodes every group concurrently and yields
  one outcome per unit, ids minted through an injected `NewId`;
  **`redecodeFormat`** re-runs one format's units from their retained files
  under new settings, keeping every id and position (a re-decode that yields
  more units than it started with keeps the id on the first).
- `src/plan-write.ts` — **`planUnitWrite(unit, selection)`**, the pure half of
  the confirm: a `write` of exactly the reviewed resources (exclusions
  applied, inline edits substituted, in review order) with the `excluded`
  count, or a `skip` with its **`SkipReason`** (`nothing` / `unreadable`). It
  adds no provenance and rewrites nothing: the format's `decode` already
  minted the source file and stamped `meta.source`.

## Layering

Depends on `importer-fundamentals` (the contract, `PickedFile`, `StagedImport`),
the three `*-importer-core` bindings (the descriptors the registry lists),
`fhir-r4` (the `FhirResource` type), and `effect`. Depended on by
`importer-react`. Imports no `*-importer-react`, no `web-trace-core`, and
nothing from `slices/collector` or `slices/http-extraction`.

## Guardrails

- **No source-file knowledge here.** What a source file is, which resources
  point at it, and what happens to those links when the reviewer excludes it
  are each format's decisions, made inside its `decode` through
  `importer-fundamentals`' helpers. `readBatch` and `planUnitWrite` treat the
  source-file row as any other resource. Do not reintroduce a shell-side
  mint, a side map of source files, or a "primary file".
- **Unit ids are minted once and kept.** The reviewer's selection is keyed
  by unit id, so `redecodeFormat` never re-mints an id a unit already has.
- **`decode` never fails.** A malformed file is an `unreadable` unit, folded
  by the format; there is no `catchAll` in the read half, and a format that
  raised would be a contract bug, not a case to handle here.
- **Dispatch generically, not by `Match`.** Indexing the registry by a
  `FormatKind` union loses the per-format correlation; a generic
  `<K extends FormatKind>(kind: K)` helper keeps it. Add formats to the
  registry, never a branch to this package.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — package roles and layering.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  descriptor contract, the source-file helpers, and `StagedImport`.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  runs these functions from its hooks.
- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the registry edit a new format makes here.
