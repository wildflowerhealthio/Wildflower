/**
 * The pure core of the importer slice: the closed format registry — every
 * registered {@link FileImporter}, typed per format — and the batch
 * machinery a shell drives: group a pick by format, read it into a
 * {@link DecodedBatch}, re-decode one format under new settings, find
 * the batch's referents and resolve its mentions, and plan the batch's
 * write from its reviewed selections.
 *
 * @remarks
 * Sits between the format bindings (`har-importer-core`,
 * `lifelabs-pdf-importer`, `dicom-importer-core`) and the React shell
 * (`importer-react`), which adds each format's `SettingsPicker` to the
 * registry here and runs these functions from its hooks. No DOM, no `fs`, no
 * React, no client: every export is a value or a service-free Effect.
 *
 * @packageDocumentation
 */
export { defaultFormatSettings, formatKinds, formatRegistry } from './registry.ts'
export type { BoundFormat, FormatKind, FormatSettings } from './registry.ts'
// `groupByFormat`, `decodeFormat` and `identifyPick` are steps of `readBatch`,
// not a surface: the shell drives the whole read, never a leg of it. They stay
// module-level exports for `read-batch.test.ts` and are not re-exported here.
export {
  type DecodedBatch,
  claimedFormats,
  readBatch,
  redecodeFormat,
  type UnrecognizedFile,
} from './read-batch.ts'
export {
  type Disposition,
  planWrite,
  type SelectionFor,
  type SkipReason,
  skipReasonFor,
  type WriteDecision,
} from './plan-write.ts'
export { LINKED_GROUP, type ReviewGroup } from './review-group.ts'
export {
  discoverReferents,
  type LinkChoices,
  resolveMentions,
  resolveMentionsWithFallback,
  type ResolvedBatch,
} from './resolve-mentions.ts'
