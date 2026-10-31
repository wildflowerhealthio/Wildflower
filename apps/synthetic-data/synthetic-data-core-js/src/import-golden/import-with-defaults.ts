import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  claimedFormats,
  type DecodedBatch,
  type DecodeRequirements,
  defaultFormatSettings,
  type Disposition,
  type FormatKind,
  type FormatSettings,
  formatKinds,
  formatRegistry,
  isSourceFileOf,
  keysWithoutPatientOf,
  LINKED_GROUP,
  planWrite,
  readBatch,
  resolveMentions,
  type ReviewGroup,
  type WriteDecision,
} from '@wildflowerhealthio/importer-core'
import {
  DecodedFile,
  LinkChoiceSet,
  PickedFile,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Order, Schema } from 'effect'

/**
 * A picked batch imported headless through `importer-core` with every
 * default accepted, onto a device that holds nothing: read (`readBatch`),
 * resolve (`resolveMentions`) with every referent on its default link
 * choice, and the write plan (`planWrite`) with no reviewer change. What
 * comes back is what the confirm would write, what the review leaves out,
 * and the review it is written from, as the golden JSON the import golden
 * pin compares.
 *
 * @packageDocumentation
 */

/** One reviewed row: where it is reviewed, its key and title, what it holds, and its disposition. */
interface ReviewRow {
  readonly group: ReviewGroup
  readonly key: string
  readonly title: string
  readonly resource: string
  readonly disposition: Disposition
}

/** A written source file, and the id the same file mints when it is picked again off the server. */
interface SourceFileRePick {
  readonly written: string
  readonly rePicked: readonly string[]
}

/** What an import with every default accepted writes, and the review it writes it from. */
interface DefaultImport {
  /** Every resource the transaction writes, as JSON, in `Type/id` order. */
  readonly written: readonly unknown[]
  /**
   * Every resource the review leaves out, as JSON, in `Type/id` order: not
   * written, but what a reviewer's tick would write.
   */
  readonly excluded: readonly unknown[]
  /** Every reviewed row, in submit order. */
  readonly review: readonly ReviewRow[]
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

/** The resources of `plan`'s decisions of `disposition`, as JSON, in `Type/id` order. */
const encodedResourcesOf = (
  plan: readonly WriteDecision[],
  disposition: Disposition
): readonly unknown[] =>
  plan
    .filter((decision) => decision.disposition === disposition)
    .map(({ entry }) => entry.resource)
    .toSorted(Order.mapInput(Order.string, literalReferenceOf))
    .map((resource) => encodeResource(resource))

/** Every source file of `kind` in `batch`'s decode. */
const sourceFilesOf = (batch: DecodedBatch, kind: FormatKind): readonly FhirResourceWithId[] =>
  DecodedFile.resources(batch.formats[kind].decoded)
    .map(({ resource }) => resource)
    .filter((resource) => isSourceFileOf(kind, resource))

/**
 * `sourceFile`, a source file of `kind`, picked again as the server's
 * source-file list picks it (`PickedFile.FromDocumentReference` under the
 * format's constants, its name and bytes alone), and read: the ids of the
 * source files the re-read mints.
 */
const rePickedIdsOf = (
  kind: FormatKind,
  sourceFile: FhirResourceWithId
): Effect.Effect<readonly string[], unknown, DecodeRequirements> =>
  Schema.decodeUnknown(PickedFile.FromDocumentReference)(sourceFile).pipe(
    Effect.provideService(PickedFile.Format, formatRegistry[kind].sourceFileFormat),
    Effect.flatMap(({ fileName, bytes }) =>
      readBatch(formatRegistry, SETTINGS, [{ fileName, bytes }])
    ),
    Effect.map((rePicked) =>
      formatKinds.flatMap((rePickedKind) =>
        sourceFilesOf(rePicked, rePickedKind).map(literalReferenceOf)
      )
    )
  )

/**
 * `picks` imported with every default accepted, onto an empty device. The
 * read requires the registry's `DecodeRequirements`, which the caller
 * provides.
 *
 * @param picks - The batch, in pick order
 * @returns What the confirm writes and the review it writes it from; fails
 *   when a file is unreadable or unrecognized, so a golden never pins a
 *   broken input
 */
const importWithDefaults = (
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<DefaultImport, unknown, DecodeRequirements> =>
  Effect.gen(function* () {
    const decodedBatch = yield* readBatch(formatRegistry, SETTINGS, picks)
    const kinds = claimedFormats(decodedBatch.formats)
    const unread = [
      ...decodedBatch.unrecognizedFiles.map(({ title }) => title),
      ...kinds.flatMap((kind) =>
        decodedBatch.formats[kind].unreadableFiles.map(({ title }) => title)
      ),
    ]
    if (unread.length > 0) return yield* Effect.fail(`Not read: ${unread.join(', ')}`)

    // On a device that holds nothing, `ReferentSearch.defaultChoices` finds
    // no record, so every referent takes its kind's default: no choice made.
    const batch = yield* resolveMentions(decodedBatch, LinkChoiceSet.empty)
    // The screen's default with no row on the server: every row left
    // without a patient is out.
    const plan = planWrite(
      batch,
      () => StagedImport.initial(),
      (kind) => keysWithoutPatientOf(batch, kind, StagedImport.initial()),
      new Set()
    )
    const included = plan.filter(({ disposition }) => disposition === 'Included')
    const sourceFileRePicks = yield* Effect.forEach(
      included.flatMap(({ group, entry }) =>
        group !== LINKED_GROUP && isSourceFileOf(group, entry.resource)
          ? [{ kind: group, sourceFile: entry.resource }]
          : []
      ),
      ({ kind, sourceFile }) =>
        Effect.map(rePickedIdsOf(kind, sourceFile), (rePicked): SourceFileRePick => ({
          written: literalReferenceOf(sourceFile),
          rePicked,
        }))
    )
    return {
      written: encodedResourcesOf(plan, 'Included'),
      excluded: encodedResourcesOf(plan, 'Excluded'),
      review: plan.map(({ group, entry, disposition }) => ({
        group,
        key: entry.key,
        title: entry.title,
        resource: literalReferenceOf(entry.resource),
        disposition,
      })),
      notes: Object.fromEntries(kinds.map((kind) => [kind, batch.formats[kind].decoded.notes])),
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
const goldenTextOf = (imported: DefaultImport): string =>
  `${JSON.stringify(imported, withSortedKeys, 2)}\n`

export { goldenTextOf, importWithDefaults }
export type { DefaultImport }
