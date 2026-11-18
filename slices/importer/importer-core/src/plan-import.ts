import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  type BatchReadRejected,
  type BatchSubmitFailure,
  type FhirR4ResourcesHttpApiClient,
  MatchQuery,
  readInBatch,
  ResourceMatch,
} from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  FileCopy,
  FormatDecode,
  ImportPlan,
  PickedFile,
  RecordReferences,
  ResourcePlan,
  SectionedList,
  type StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, HashMap, Option, type ParseResult } from 'effect'

import { type ImportingFormat, sourceFileKey, sourceFileOf } from './import-decoded.ts'

/**
 * The import plan's stage work: one format's decode read as copies of
 * records, and an import's records matched against the store, once, for the
 * plan's suggestions.
 *
 * @packageDocumentation
 */

/** What finding an import's stored match can fail with: any failed search or read. */
type StoredMatchFailure =
  | ResourceMatch.Failure
  | BatchSubmitFailure
  | BatchReadRejected
  | ParseResult.ParseError

/** The copy of a placed record of the file set whose picked files are `pickedFiles`. */
const placedCopyOf = (
  format: string,
  pickedFiles: DecodedFileSet.Type['pickedFiles'],
  { record, plan, isImplied }: DecodedFileSet.PlacedRecord
): FileCopy.Type => {
  const reviewKey = `${FormatDecode.keyPrefix(pickedFiles[0].pickedFile)}${record.localKey}`
  return {
    format,
    pickedFiles: Arr.map(pickedFiles, ({ pickedFile }) => pickedFile),
    reviewKey,
    title: DecodedFileSet.writtenReferenceTitle(plan, reviewKey),
    isImplied,
    resource: record.resource,
    sourceUrl: record.sourceUrl,
    derivedId: ResourcePlan.match(plan, {
      Derived: ({ id }) => Option.some(id),
      Minted: () => Option.none(),
    }),
  }
}

/**
 * The copy of the source file one picked file of a set is stored as: the
 * source file the import stage mints, carrying what the file identified
 * itself as, detached, its content-derived id kept as its derived id.
 */
const sourceFileCopyOf = (
  format: string,
  pickedFiles: DecodedFileSet.Type['pickedFiles'],
  { pickedFile, identifiedAs }: DecodedFileSet.PickedFileIdentity
): Effect.Effect<FileCopy.Type, ParseResult.ParseError, PickedFile.Format> =>
  Effect.map(sourceFileOf(pickedFile), (sourceFile) => ({
    format,
    pickedFiles: Arr.map(pickedFiles, (picked) => picked.pickedFile),
    reviewKey: sourceFileKey(pickedFile),
    title: pickedFile.fileName,
    isImplied: false,
    resource: { ...sourceFile, id: null, masterIdentifier: Option.getOrNull(identifiedAs) },
    sourceUrl: Option.none(),
    derivedId: Option.some(sourceFile.id),
  }))

/**
 * One file set's copies: its source files first, as the import stage leads
 * with them, then its placed records (`DecodedFileSet.placedRecordsOf`) in
 * section order.
 *
 * @remarks
 * The ids `placedRecordsOf` mints for keyless records are not kept: a copy
 * holds its record detached.
 */
const fileSetCopiesOf = (
  format: string,
  fileSet: DecodedFileSet.Type
): Effect.Effect<readonly FileCopy.Type[], ParseResult.ParseError, PickedFile.Format> =>
  Effect.gen(function* () {
    const sourceFileCopies = yield* Effect.forEach(fileSet.pickedFiles, (picked) =>
      sourceFileCopyOf(format, fileSet.pickedFiles, picked)
    )
    const placed = yield* DecodedFileSet.placedRecordsOf(fileSet.sectionedList, randomResourceId)
    return [
      ...sourceFileCopies,
      ...SectionedList.rows(placed).map((placedRecord) =>
        placedCopyOf(format, fileSet.pickedFiles, placedRecord)
      ),
    ]
  })

/**
 * Every copy one format's decode brings, file set by file set, in plan order.
 *
 * @param importer - The format's importer, whose source-file format its
 *   source files are minted under
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The copies; fails with the `ParseError` of the first file set
 *   whose source file cannot be minted or whose implied record its schema
 *   rejects
 */
const fileCopiesOf = (
  importer: Pick<ImportingFormat, 'sourceFileFormat'>,
  decoded: FormatDecode.Decoded<string>
): Effect.Effect<readonly FileCopy.Type[], ParseResult.ParseError> =>
  Effect.forEach(decoded.fileSets, (fileSet) => fileSetCopiesOf(decoded.format, fileSet)).pipe(
    Effect.map(Arr.flatten),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

/** The literal reference `record` is stored under from an earlier import, `None` with no derived id. */
const derivedReferenceOf = ({ copies: [record] }: FileCopy.RecordCopies): Option.Option<string> =>
  Option.map(record.derivedId, (id) => `${record.resource.resourceType}/${id}`)

/**
 * The stored record under each derived id of `records` that no candidate was
 * found by identifier for: one batch of reads, sent only when there is one.
 */
const storedUnderDerivedIdOf = (
  records: readonly FileCopy.RecordCopies[],
  candidatesByRecord: readonly (readonly ResourceMatch.Candidate[])[]
): Effect.Effect<
  StoredMatch.Type['storedUnderDerivedIdByRecord'],
  StoredMatchFailure,
  FhirR4ResourcesHttpApiClient
> => {
  const reads = Arr.filterMap(Arr.zip(records, candidatesByRecord), ([record, candidates]) =>
    Suggestion.noneFoundByIdentifier(candidates)
      ? Option.map(derivedReferenceOf(record), (reference) => [record.key, reference] as const)
      : Option.none()
  )
  return Effect.map(readInBatch(reads.map(([, reference]) => reference)), (stored) =>
    HashMap.fromIterable(
      Arr.filterMap(Arr.zip(reads, stored), ([[key], storedResource]) =>
        Option.map(storedResource, (resource) => [key, resource] as const)
      )
    )
  )
}

/**
 * What the store holds of `records` and of `unresolved`: one
 * `ResourceMatch.findCandidates` over every record, by its first copy, and
 * every unresolved logical reference, every grade; then one batch of reads
 * for the stored records under the derived ids of the records nothing was
 * found for by identifier.
 *
 * @param records - The import's records, each with its copies
 * @param unresolved - The logical references that name no record of the
 *   import (`RecordReferences.Type`'s `unresolved`)
 * @returns The stored match; fails when any search or read fails, since a
 *   failed search is not "no match"
 */
const findStoredMatch = (
  records: readonly FileCopy.RecordCopies[],
  unresolved: readonly LogicalReference.Type[]
): Effect.Effect<StoredMatch.Type, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const queries: readonly MatchQuery.Type[] = [
      ...records.map(({ copies: [record] }) => MatchQuery.fromResource(record.resource)),
      ...unresolved.map(MatchQuery.fromLogicalReference),
    ]
    const candidates = yield* ResourceMatch.findCandidates(queries, {
      onlyCertainMatches: false,
      count: Option.none(),
    })
    const [candidatesByRecord, candidatesByReference] = Arr.splitAt(candidates, records.length)
    return {
      candidatesByRecord: HashMap.fromIterable(
        Arr.zip(
          records.map(({ key }) => key),
          candidatesByRecord
        )
      ),
      storedUnderDerivedIdByRecord: yield* storedUnderDerivedIdOf(records, candidatesByRecord),
      candidatesByUnresolvedReference: HashMap.fromIterable(
        Arr.zip(
          unresolved.map((logicalReference) => LogicalReference.key(logicalReference)),
          candidatesByReference
        )
      ),
    }
  })

/**
 * The import plan of `copies`: their records matched against the store
 * ({@link findStoredMatch}) and suggested from it (`ImportPlan.make`).
 *
 * @param copies - Every copy of every record of the import, in plan order
 */
const planImport = (
  copies: readonly FileCopy.Type[]
): Effect.Effect<ImportPlan.Type, StoredMatchFailure, FhirR4ResourcesHttpApiClient> => {
  const records = FileCopy.groupByRecord(copies)
  return Effect.map(
    findStoredMatch(records, RecordReferences.of(records).unresolved),
    (storedMatch) => ImportPlan.make(copies, storedMatch)
  )
}

export { fileCopiesOf, findStoredMatch, planImport }
export type { StoredMatchFailure }
