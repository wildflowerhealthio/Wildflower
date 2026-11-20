/**
 * An import's stored match: its records and its unresolved references
 * matched against the store, once, for the plan's suggestions.
 *
 * @packageDocumentation
 */
import {
  type BatchReadRejected,
  type BatchSubmitFailure,
  type FhirR4ResourcesHttpApiClient,
  MatchQuery,
  readInBatch,
  ResourceMatch,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResourceWithId, LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { ImportedRecord, StoredMatch } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, HashMap, Option, type ParseResult } from 'effect'

/** What finding an import's stored match can fail with: any failed search or read. */
type StoredMatchFailure =
  | ResourceMatch.Failure
  | BatchSubmitFailure
  | BatchReadRejected
  | ParseResult.ParseError

/**
 * The stored record under each of `records`' derived stage ids
 * (`ImportedRecord.literalReferenceIfDerived`), in record order, `None` for a
 * record whose id is minted or under whose id nothing is stored: one batch
 * of reads, sent only when there is one.
 */
const storedUnderDerivedIdsOf = (
  records: readonly ImportedRecord.Type[]
): Effect.Effect<
  readonly Option.Option<FhirResourceWithId>[],
  StoredMatchFailure,
  FhirR4ResourcesHttpApiClient
> => {
  const reads = Arr.filterMap(records, (record) =>
    Option.map(
      ImportedRecord.literalReferenceIfDerived(record),
      (literalReference) => [record.key, literalReference] as const
    )
  )
  return Effect.map(
    readInBatch(reads.map(([, literalReference]) => literalReference)),
    (stored) => {
      const storedByKey = HashMap.fromIterable(
        Arr.zipWith(reads, stored, ([key], storedResource) => [key, storedResource] as const)
      )
      return records.map(({ key }) => HashMap.get(storedByKey, key).pipe(Option.flatten))
    }
  )
}

/**
 * What the store holds of `records` and of `unresolved`: one
 * `ResourceMatch.findCandidates` over every record, by its resource
 * (`ImportedRecord.resourceOf`), and every unresolved logical reference,
 * every grade; then one batch of reads for the stored records under the
 * derived stage ids of every record that has one.
 *
 * @param records - The import's records, each with its copies
 * @param unresolved - The logical references that name no record of the
 *   import (`RecordReferences.Type`'s `unresolved`)
 * @returns The stored match; fails when any search or read fails, since a
 *   failed search is not "no match"
 *
 * @remarks
 * The searches answer in the order they were asked, records first, so the
 * answers split at the number of records.
 */
const findStoredMatch = (
  records: readonly ImportedRecord.Type[],
  unresolved: readonly LogicalReference.Type[]
): Effect.Effect<StoredMatch.Type, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const queries: readonly MatchQuery.Type[] = [
      ...records.map((record) => MatchQuery.fromResource(ImportedRecord.resourceOf(record))),
      ...unresolved.map(MatchQuery.fromLogicalReference),
    ]
    const candidates = yield* ResourceMatch.findCandidates(queries, {
      onlyCertainMatches: false,
      count: Option.none(),
    })
    const [candidatesOfRecords, candidatesOfReferences] = Arr.splitAt(candidates, records.length)
    const storedUnderDerivedIds = yield* storedUnderDerivedIdsOf(records)
    return StoredMatch.make({
      records: Arr.zipWith(
        records,
        Arr.zip(candidatesOfRecords, storedUnderDerivedIds),
        ({ key }, [recordCandidates, storedUnderDerivedId]) =>
          [key, StoredMatch.makeEntry(recordCandidates, storedUnderDerivedId)] as const
      ),
      references: Arr.zip(unresolved, candidatesOfReferences),
    })
  })

export { findStoredMatch }
export type { StoredMatchFailure }
