import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  claimedFormats,
  type DecodedBatch,
  defaultFormatSettings,
  type Disposition,
  discoverReferents,
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
} from '@wildflowerhealthio/importer-core'
import {
  DecodedFile,
  MentionLinkChoiceSet,
  PickedFile,
  Referent,
  ReferentLinkChoiceSet,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Order, Schema } from 'effect'

/**
 * A picked batch imported headless through `importer-core` with every
 * default accepted, onto a device that holds nothing: read (`readBatch`),
 * each referent's default link choice, resolve (`resolveMentions`), and the
 * write plan (`planWrite`) with no reviewer change. What comes back is what
 * the confirm would write, and the review it would be written from, as the
 * golden JSON the import golden pin compares.
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

/**
 * Each referent's link choice on a device that holds nothing: what
 * `ReferentSearch.defaultChoice` answers when no search finds a record.
 */
const defaultLinkChoicesOf = (referents: readonly Referent.Type[]): ReferentLinkChoiceSet.Type =>
  HashMap.fromIterable(
    referents.map((referent) => [
      Referent.key(referent),
      ReferentLinkChoiceSet.defaultFor(referent),
    ])
  )

const encodeResource = Schema.encodeSync(FhirResourceSchema)

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
): Effect.Effect<readonly string[], unknown> =>
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
 * `picks` imported with every default accepted, onto an empty device.
 *
 * @param picks - The batch, in pick order
 * @returns What the confirm writes and the review it writes it from; fails
 *   when a file is unreadable or unrecognized, so a golden never pins a
 *   broken input
 */
const importWithDefaults = (
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<DefaultImport, unknown> =>
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

    const referents = yield* discoverReferents(decodedBatch)
    const batch = yield* resolveMentions(decodedBatch, {
      byReferent: defaultLinkChoicesOf(referents),
      byMention: MentionLinkChoiceSet.empty,
    })
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
      written: included
        .map(({ entry }) => entry.resource)
        .toSorted(Order.mapInput(Order.string, literalReferenceOf))
        .map((resource) => encodeResource(resource)),
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
