/**
 * The pure core of the importer slice: the closed format registry — every
 * registered {@link FileImporterDescriptor}, typed per format — and the batch
 * machinery a shell drives: group a pick by format, read it into review
 * units, re-decode one format's units under new settings, and plan a unit's
 * write from its reviewed selection.
 *
 * @remarks
 * Sits between the format bindings (`har-importer-core`,
 * `lifelabs-pdf-importer-core`, `dicom-importer-core`) and the React shell
 * (`importer-react`), which adds each format's `SettingsPicker` to the
 * registry here and runs these functions from its hooks. No DOM, no `fs`, no
 * React, no client: every export is a value or a service-free Effect.
 *
 * @packageDocumentation
 */
export { defaultFormatSettings, formatKinds, formatRegistry } from './registry.ts'
export type { BoundFormat, FormatKind, FormatSettings, FormatVariant } from './registry.ts'
export type {
  ReadUnit,
  UnitReadOutcome,
  UnreadableUnit,
  UnrecognizedFile,
} from './unit-read-outcome.ts'
export {
  decodeFormat,
  groupByFormat,
  type GroupedPicks,
  identifyPick,
  type NewId,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
} from './read-batch.ts'
export { planUnitWrite, type SkipReason, type WritePlan } from './plan-write.ts'
