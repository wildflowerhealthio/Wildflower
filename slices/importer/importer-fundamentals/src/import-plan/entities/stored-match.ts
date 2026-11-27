/**
 * A stored match: what the store holds of an import's records and of its
 * external references, found before the plan is built.
 *
 * @remarks
 * An external reference points outside the import: it names its target by
 * an identifier no record of the import carries, so the store is asked
 * whether it holds that target.
 *
 * @packageDocumentation
 */
import { MatchGrade, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type FhirResourceWithId,
  LogicalReference,
  sameStoredResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, Option } from 'effect'

import type * as RecordKey from './record-key.ts'

/**
 * What the store holds of one record: its stored candidates and the stored
 * record under the id the import stage derived for it.
 *
 * @remarks
 * `storedUnderDerivedId` is read for every record whose stage id is derived
 * (`ImportedCopy.StageId`), whatever was found for it by identifier; `None`
 * when its id is minted or nothing is stored there.
 */
interface Entry {
  /** The stored records matching it, best grade first. */
  readonly candidates: readonly ResourceMatch.Candidate[]
  readonly storedUnderDerivedId: Option.Option<FhirResourceWithId>
}

/**
 * A stored record found for a record, beside the grade it was found with;
 * `None` for the record stored under its derived id that no search found.
 */
interface FoundRecord {
  readonly existing: FhirResourceWithId
  readonly grade: Option.Option<MatchGrade.Type>
}

/**
 * Each record's {@link Entry} by its key, and the stored candidates of each
 * external reference's target, best grade first, by `LogicalReference.key`.
 */
interface Type {
  readonly byRecord: HashMap.HashMap<RecordKey.Type, Entry>
  readonly byExternalReference: HashMap.HashMap<
    LogicalReference.Key,
    readonly ResourceMatch.Candidate[]
  >
}

/** What the store holds of a record it holds nothing of. */
const NOTHING_FOUND: Entry = { candidates: [], storedUnderDerivedId: Option.none() }

/** Nothing stored matches. */
const empty: Type = { byRecord: HashMap.empty(), byExternalReference: HashMap.empty() }

/** One record's entry: its `candidates` and what is stored under its derived id. */
const makeEntry = (
  candidates: readonly ResourceMatch.Candidate[],
  storedUnderDerivedId: Option.Option<FhirResourceWithId>
): Entry => ({ candidates, storedUnderDerivedId })

/**
 * The stored match of `records`, each record's key beside its entry, and of
 * `externalReferences`, each beside the stored candidates of its target.
 */
const make = ({
  records,
  externalReferences,
}: {
  readonly records: Iterable<{ readonly key: RecordKey.Type; readonly entry: Entry }>
  readonly externalReferences: Iterable<{
    readonly externalReference: LogicalReference.Type
    readonly candidates: readonly ResourceMatch.Candidate[]
  }>
}): Type => ({
  byRecord: HashMap.fromIterable(
    Arr.map(Arr.fromIterable(records), ({ key, entry }) => [key, entry])
  ),
  byExternalReference: HashMap.fromIterable(
    Arr.map(Arr.fromIterable(externalReferences), ({ externalReference, candidates }) => [
      LogicalReference.key(externalReference),
      candidates,
    ])
  ),
})

/** What the store holds of the record under `key`; nothing found when it has no entry. */
const ofRecord = (storedMatch: Type, key: RecordKey.Type): Entry =>
  HashMap.get(storedMatch.byRecord, key).pipe(Option.getOrElse(() => NOTHING_FOUND))

/** The stored candidates of `externalReference`'s target, best grade first; none when it has no entry. */
const ofReference = (
  storedMatch: Type,
  externalReference: LogicalReference.Type
): readonly ResourceMatch.Candidate[] =>
  HashMap.get(storedMatch.byExternalReference, LogicalReference.key(externalReference)).pipe(
    Option.getOrElse(() => [])
  )

/** The stored records among `candidates` found by identifier: each carries an identifier of the record. */
const foundByIdentifier = (
  candidates: readonly ResourceMatch.Candidate[]
): readonly FhirResourceWithId[] =>
  candidates.filter(({ by }) => by === 'identifier').map(({ resource }) => resource)

/**
 * The stored records that are the record, its stored copies: the candidates
 * found by identifier and the one under its derived id, each once by literal
 * reference.
 */
const storedCopiesOf = (entry: Entry): readonly FhirResourceWithId[] =>
  Arr.dedupeWith(
    [...foundByIdentifier(entry.candidates), ...Option.toArray(entry.storedUnderDerivedId)],
    sameStoredResource
  )

/**
 * The name matches a suggestion counts: the stored records found by name
 * graded so they may not need more review
 * (`MatchGrade.mayNotNeedAdditionalReview`), best grade first. A `possible`
 * match is not one.
 */
const nameMatchesOf = (entry: Entry): readonly FhirResourceWithId[] =>
  entry.candidates
    .filter(({ by, grade }) => by === 'name' && MatchGrade.mayNotNeedAdditionalReview(grade))
    .map(({ resource }) => resource)

/**
 * Every stored record found for the record, each once
 * (`sameStoredResource`) with the grade it was found with: the candidates
 * found by identifier or by name, any grade, `possible` included, best grade
 * first, then the record under its derived id (grade `None`) when no
 * candidate is that stored record.
 *
 * @remarks
 * These are the stored records a reviewer can pick for the record to merge
 * into: a `possible` match is among them though no suggestion counts it
 * ({@link nameMatchesOf}), since the reviewer may know better.
 */
const foundRecordsOf = (entry: Entry): readonly FoundRecord[] =>
  Arr.dedupeWith(
    [
      ...entry.candidates.map(({ resource, grade }): FoundRecord => ({
        existing: resource,
        grade: Option.some(grade),
      })),
      ...Option.toArray(entry.storedUnderDerivedId).map((existing): FoundRecord => ({
        existing,
        grade: Option.none(),
      })),
    ],
    (left, right) => sameStoredResource(left.existing, right.existing)
  )

/**
 * The stored copies of the record `externalReference` names: its candidates
 * found by identifier ({@link ofReference}).
 */
const storedCopiesOfReference = (
  storedMatch: Type,
  externalReference: LogicalReference.Type
): readonly FhirResourceWithId[] => foundByIdentifier(ofReference(storedMatch, externalReference))

export {
  empty,
  foundRecordsOf,
  make,
  makeEntry,
  nameMatchesOf,
  ofRecord,
  ofReference,
  storedCopiesOf,
  storedCopiesOfReference,
}
export type { Entry, FoundRecord, Type }
