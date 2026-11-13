/**
 * The stored records an import's records match, found once per import
 * (`fhir-r4/clients`' `ResourceMatch.matchAll`, one batch for every record):
 * what a referent's default link choice and the server diff both read.
 *
 * @remarks
 * A referent reads its own candidates, every grade (`ReferentMatch`). The
 * server diff reads a record's matched copy ({@link matchedCopyOf}): the
 * stored record its identifiers name, found again among the records the
 * match fetched by identifier, so a record the review changes (a resolved
 * referent carrying the identifiers it assumed) is read without another
 * request when the match searched its identifiers, and is
 * {@link MatchedCopy.NotSearched} when it did not.
 *
 * @packageDocumentation
 */

import {
  distinctByReference,
  type FhirR4ResourcesHttpApiClient,
  isSearchableResourceType,
  MatchQuery,
  ResourceMatch,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  literalReferenceOf,
  LogicalReference,
  type ResourceType,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Effect, HashMap, HashSet, Option, pipe } from 'effect'

/** The stored records an import's records match. */
interface Type {
  /** Each matched record's candidates, best grade first, by the record's literal reference. */
  readonly candidatesByRecord: HashMap.HashMap<string, readonly ResourceMatch.Candidate[]>
  /** Every stored record the match found by identifier, under each identifier it carries. */
  readonly foundByIdentifier: ResourceMatch.IdentifierIndex
  /** The key of every identifier the match searched, under its record's type. */
  readonly searchedIdentifiers: HashSet.HashSet<LogicalReference.Key>
}

/** Nothing matched: what a review starts from before, or without, a match. */
const empty: Type = {
  candidatesByRecord: HashMap.empty(),
  foundByIdentifier: {},
  searchedIdentifiers: HashSet.empty(),
}

/** The key `identifier` of a record of `resourceType` is searched under. */
const identifierKey = (
  resourceType: ResourceType.Type,
  identifier: IdentifierAndReference.QualifiedIdentifierType
): LogicalReference.Key => LogicalReference.key(LogicalReference.make(resourceType, identifier))

/** The keys of the identifiers the identifier stage searches `query` by: none for a type it cannot search. */
const searchedKeysOf = (query: MatchQuery.Type): readonly LogicalReference.Key[] =>
  isSearchableResourceType(query.resourceType)
    ? query.identifier.map((identifier) => identifierKey(query.resourceType, identifier))
    : []

/**
 * The stored records `records` match: one `ResourceMatch.matchAll` over
 * every one of them, every grade, each record matched once by its literal
 * reference (the first of `records` under it is the one matched).
 *
 * @param records - The import's records, the copy each referent links by first
 * @returns The candidates of each, the stored records found by identifier
 *   and the identifiers searched; fails when any search fails, which is not
 *   "no match"
 */
const find = (
  records: readonly FhirResourceWithId[]
): Effect.Effect<Type, ResourceMatch.Failure, FhirR4ResourcesHttpApiClient> => {
  const matched = distinctByReference(records)
  const queries: readonly MatchQuery.Type[] = matched.map(MatchQuery.fromResource)
  return Effect.map(
    ResourceMatch.matchAll(queries, { onlyCertainMatches: false, count: Option.none() }),
    (candidatesPerRecord): Type => ({
      candidatesByRecord: HashMap.fromIterable(
        Array.zip(matched.map(literalReferenceOf), candidatesPerRecord)
      ),
      foundByIdentifier: ResourceMatch.indexByIdentifier(
        pipe(
          candidatesPerRecord.flat(),
          Array.filter(({ by }) => by === 'identifier'),
          Array.map(({ resource }) => resource),
          distinctByReference
        )
      ),
      searchedIdentifiers: HashSet.fromIterable(queries.flatMap(searchedKeysOf)),
    })
  )
}

/** The candidates the match found for `record`, by its literal reference; none for a record it did not match. */
const candidatesOf = (
  importMatch: Type,
  record: FhirResourceWithId
): readonly ResourceMatch.Candidate[] =>
  HashMap.get(importMatch.candidatesByRecord, literalReferenceOf(record)).pipe(
    Option.getOrElse(() => [])
  )

/**
 * What the match says of a record's stored copy: `Found`, the copy the
 * server diff compares it with; `NotFound`, no stored record its identifiers
 * name; `NotSearched`, a record the match cannot speak for (no qualified
 * identifier, a type with no identifier search, or an identifier the match
 * did not search). The diff reads both of the last under the record's own id.
 */
type MatchedCopy =
  | { readonly _tag: 'Found'; readonly copy: FhirResourceWithId }
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'NotSearched' }

const MatchedCopy = Data.taggedEnum<MatchedCopy>()

/**
 * The stored copy `record` matches: the one stored record carrying any of
 * its identifiers (a `certain` candidate), else, when they name several,
 * the one under `record`'s own literal reference, the one its write
 * overwrites; read among the records the match found by identifier, so
 * without a request.
 *
 * @remarks
 * `NotSearched` unless every qualified identifier of `record` was searched
 * by the match, since a stored record carrying one it did not search is
 * unknown to it: a record the import holds is searched by its own, and a
 * resolved referent carrying identifiers it assumed from a stored copy the
 * match never searched by is read by id instead.
 */
const matchedCopyOf = (importMatch: Type, record: FhirResourceWithId): MatchedCopy => {
  const query = MatchQuery.fromResource(record)
  const searchedKeys = searchedKeysOf(query)
  const searched =
    Array.isNonEmptyReadonlyArray(searchedKeys) &&
    searchedKeys.every((key) => HashSet.has(importMatch.searchedIdentifiers, key))
  if (!searched) return MatchedCopy.NotSearched()
  const candidates = ResourceMatch.identifierCandidatesOf(query, importMatch.foundByIdentifier)
  return pipe(
    Array.findFirst(candidates, ({ grade }) => grade === 'certain'),
    Option.orElse(() =>
      Array.findFirst(
        candidates,
        ({ resource }) => literalReferenceOf(resource) === literalReferenceOf(record)
      )
    ),
    Option.match({
      onNone: () => MatchedCopy.NotFound(),
      onSome: ({ resource }) => MatchedCopy.Found({ copy: resource }),
    })
  )
}

export { candidatesOf, empty, find, MatchedCopy, matchedCopyOf }
export type { Type }
