import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodeRequirements,
  defaultFormatSettings,
  type FormatKind,
  formatRegistry,
  type FormatSettings,
  importWithSuggestions,
  isSourceFileOf,
  noStore,
  type SuggestedImport,
} from '@wildflowerhealthio/importer-core'
import {
  ImportedRecord,
  PickedFile,
  type PlanResolution,
  type Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Option, Order, Schema } from 'effect'

/**
 * A picked batch imported headless through `importer-core` with every
 * suggestion taken, onto a device that holds nothing
 * (`importWithSuggestions` with `noStore`), so every record is saved as new.
 * What comes back is what the transaction writes and the plan it is written
 * from, as the golden JSON the import golden pin compares.
 *
 * @packageDocumentation
 */

/**
 * One record of the plan as resolved: the review keys of its copies, its
 * title, why it is suggested what it is, its label, whether it is implied,
 * and the resource written for it (`null` when nothing is).
 */
interface PlannedRow {
  readonly keys: readonly string[]
  readonly title: string
  readonly reason: Suggestion.Reason['_tag']
  readonly label: PlanResolution.Label
  readonly isImplied: boolean
  readonly written: string | null
}

/** A written source file, and the id the same file mints when it is picked again off the server. */
interface SourceFileRePick {
  readonly written: string
  readonly rePicked: readonly string[]
}

/** What an import with every suggestion taken writes onto an empty store, and the plan it writes it from. */
interface EmptyStoreImport {
  /** Every resource the transaction writes, as JSON, in `Type/id` order. */
  readonly written: readonly unknown[]
  /** Every record of the plan, in plan order. */
  readonly plan: readonly PlannedRow[]
  /** Every claimed format's decode notes, by format. */
  readonly notes: Readonly<Record<string, readonly string[]>>
  /** Every written source file, picked again as the server's source-file list picks it. */
  readonly sourceFileRePicks: readonly SourceFileRePick[]
}

/**
 * Every format's default settings, the DICOM time zone fixed: its default is
 * the runtime's own zone, which would make a golden depend on the machine.
 */
const SETTINGS: FormatSettings = {
  ...defaultFormatSettings,
  dicom: { timeZone: 'America/Toronto' },
}

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/** `picks` imported with every suggestion taken, with no store (`importWithSuggestions`). */
const suggestedImportOf = (
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<SuggestedImport, unknown, DecodeRequirements> =>
  importWithSuggestions(formatRegistry, SETTINGS, picks, noStore)

/** Every source file among `imported`'s resources, beside the claimed format it is a source file of. */
const sourceFilesOf = (
  imported: SuggestedImport
): readonly (readonly [FormatKind, FhirResourceWithId])[] =>
  imported.formats.flatMap(({ format }) =>
    imported.resources
      .filter((resource) => isSourceFileOf(format, resource))
      .map((resource) => [format, resource] as const)
  )

/**
 * `sourceFile`, a source file of `kind`, picked again as the server's
 * source-file list picks it (`PickedFile.FromDocumentReference` under the
 * format's constants, its name and bytes alone), and imported: the ids of the
 * source files the import writes.
 */
const rePickedIdsOf = (
  kind: FormatKind,
  sourceFile: FhirResourceWithId
): Effect.Effect<readonly string[], unknown, DecodeRequirements> =>
  Schema.decodeUnknown(PickedFile.FromDocumentReference)(sourceFile).pipe(
    Effect.provideService(PickedFile.Format, formatRegistry[kind].sourceFileFormat),
    Effect.flatMap(({ fileName, bytes }) => suggestedImportOf([{ fileName, bytes }])),
    Effect.map((rePicked) =>
      sourceFilesOf(rePicked).map(([, resource]) => literalReferenceOf(resource))
    )
  )

/** Every record of `imported`'s resolution as a {@link PlannedRow}, in plan order. */
const plannedRowsOf = (imported: SuggestedImport): readonly PlannedRow[] =>
  imported.resolution.records.map(({ planned, label, written }) => ({
    keys: planned.record.copies.map(({ reviewKey }) => reviewKey),
    title: ImportedRecord.titleOf(planned.record),
    reason: planned.suggestion.reason._tag,
    label,
    isImplied: ImportedRecord.isImplied(planned.record),
    written: Option.getOrNull(Option.map(written, literalReferenceOf)),
  }))

/**
 * `picks` imported with every suggestion taken, onto an empty device. The
 * read requires the registry's `DecodeRequirements`, which the caller
 * provides.
 *
 * @param picks - The batch, in pick order
 * @returns What the transaction writes and the plan it writes it from; fails
 *   when a file is unreadable or unrecognized, so a golden never pins a
 *   broken input
 */
const importOntoEmptyStore = (
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<EmptyStoreImport, unknown, DecodeRequirements> =>
  Effect.gen(function* () {
    const imported = yield* suggestedImportOf(picks)
    const unread = [
      ...imported.unrecognizedFiles.map(({ title }) => title),
      ...imported.formats.flatMap(({ unreadableFiles }) =>
        unreadableFiles.map(({ title }) => title)
      ),
    ]
    if (unread.length > 0) return yield* Effect.fail(`Not read: ${unread.join(', ')}`)

    const sourceFileRePicks = yield* Effect.forEach(sourceFilesOf(imported), ([kind, sourceFile]) =>
      Effect.map(rePickedIdsOf(kind, sourceFile), (rePicked): SourceFileRePick => ({
        written: literalReferenceOf(sourceFile),
        rePicked,
      }))
    )
    return {
      written: imported.resources
        .toSorted(Order.mapInput(Order.string, literalReferenceOf))
        .map((resource) => encodeResource(resource)),
      plan: plannedRowsOf(imported),
      notes: Object.fromEntries(
        imported.formats.map(({ format, notes }) => [
          format,
          notes.flatMap((fileSet) => fileSet.notes),
        ])
      ),
      sourceFileRePicks,
    }
  })

/** A JSON value with every object's keys in code-unit order. */
const withSortedKeys = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).toSorted(Order.mapInput(Order.string, ([key]) => key))
      )
    : value

/** `imported` as its golden file's text: sorted keys, two-space indent, a trailing newline. */
const goldenTextOf = (imported: EmptyStoreImport): string =>
  `${JSON.stringify(imported, withSortedKeys, 2)}\n`

export { goldenTextOf, importOntoEmptyStore }
export type { EmptyStoreImport }
