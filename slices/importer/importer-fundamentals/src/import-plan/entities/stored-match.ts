/**
 * A stored match: what the store holds of an import's records and of the
 * logical references that name no record of the import, found before the
 * plan is built.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
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
 * Each record's {@link Entry} by its key, and each unresolved logical
 * reference's stored candidates, best grade first, by `LogicalReference.key`.
 */
interface Type {
  readonly byRecord: HashMap.HashMap<RecordKey.Type, Entry>
  readonly byReference: HashMap.HashMap<LogicalReference.Key, readonly ResourceMatch.Candidate[]>
}

/** What the store holds of a record it holds nothing of. */
const NOTHING_FOUND: Entry = { candidates: [], storedUnderDerivedId: Option.none() }

/** Nothing stored matches. */
const empty: Type = { byRecord: HashMap.empty(), byReference: HashMap.empty() }

/** One record's entry: its `candidates` and what is stored under its derived id. */
const makeEntry = (
  candidates: readonly ResourceMatch.Candidate[],
  storedUnderDerivedId: Option.Option<FhirResourceWithId>
): Entry => ({ candidates, storedUnderDerivedId })

/**
 * The stored match of `records`, each record's key beside its entry, and of
 * `references`, each unresolved logical reference beside its candidates.
 */
const make = ({
  records,
  references,
}: {
  readonly records: Iterable<readonly [RecordKey.Type, Entry]>
  readonly references: Iterable<
    readonly [LogicalReference.Type, readonly ResourceMatch.Candidate[]]
  >
}): Type => ({
  byRecord: HashMap.fromIterable(records),
  byReference: HashMap.fromIterable(
    Arr.map(Arr.fromIterable(references), ([reference, candidates]) => [
      LogicalReference.key(reference),
      candidates,
    ])
  ),
})

/** What the store holds of the record under `key`; nothing found when it has no entry. */
const ofRecord = (storedMatch: Type, key: RecordKey.Type): Entry =>
  HashMap.get(storedMatch.byRecord, key).pipe(Option.getOrElse(() => NOTHING_FOUND))

/** The stored candidates of the unresolved `reference`, best grade first; none when it has no entry. */
const ofReference = (
  storedMatch: Type,
  reference: LogicalReference.Type
): readonly ResourceMatch.Candidate[] =>
  HashMap.get(storedMatch.byReference, LogicalReference.key(reference)).pipe(
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
 * The stored copies of the record the unresolved `reference` names: its
 * candidates found by identifier ({@link ofReference}).
 */
const storedCopiesOfReference = (
  storedMatch: Type,
  reference: LogicalReference.Type
): readonly FhirResourceWithId[] => foundByIdentifier(ofReference(storedMatch, reference))

export { empty, make, makeEntry, ofRecord, ofReference, storedCopiesOf, storedCopiesOfReference }
export type { Entry, Type }
