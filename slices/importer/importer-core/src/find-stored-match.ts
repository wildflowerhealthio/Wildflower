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
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { ImportedRecord, type StoredMatch } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, HashMap, Option, type ParseResult } from 'effect'

/** What finding an import's stored match can fail with: any failed search or read. */
type StoredMatchFailure =
  | ResourceMatch.Failure
  | BatchSubmitFailure
  | BatchReadRejected
  | ParseResult.ParseError

/**
 * Whether `candidates` hold no stored record found by identifier: the
 * records whose stored record under their derived id is read.
 */
const noneFoundByIdentifier = (candidates: readonly ResourceMatch.Candidate[]): boolean =>
  !candidates.some(({ by }) => by === 'identifier')

/** The literal reference `record` is stored under from an earlier import, `None` with no derived id. */
const derivedReferenceOf = (record: ImportedRecord.Type): Option.Option<string> => {
  const { derivedId, resource } = ImportedRecord.recordCopyOf(record)
  return Option.map(derivedId, (id) => `${resource.resourceType}/${id}`)
}

/**
 * The stored record under each derived id of `records` that no candidate was
 * found by identifier for: one batch of reads, sent only when there is one.
 */
const storedUnderDerivedIdOf = (
  records: readonly ImportedRecord.Type[],
  candidatesByRecord: readonly (readonly ResourceMatch.Candidate[])[]
): Effect.Effect<
  StoredMatch.Type['storedUnderDerivedIdByRecord'],
  StoredMatchFailure,
  FhirR4ResourcesHttpApiClient
> => {
  const reads = Arr.filterMap(Arr.zip(records, candidatesByRecord), ([record, candidates]) =>
    noneFoundByIdentifier(candidates)
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
 * `ResourceMatch.findCandidates` over every record, by its resource
 * (`ImportedRecord.resourceOf`), and
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

export { findStoredMatch }
export type { StoredMatchFailure }
