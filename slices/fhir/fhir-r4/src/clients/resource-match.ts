import { Array, Effect, Equivalence, HashMap, Option, Record } from 'effect'

import type { IdentifierAndReference } from '../data-types/index.ts'
import { type FhirResourceWithId, literalReferenceOf } from '../resources/fhir-resource-with-id.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import * as LogicalReference from '../resources/logical-reference.ts'
import type * as ResourceType from '../resources/resource-type.ts'
import * as TokenSearchParam from '../resources/search/token-search-param.ts'
import type { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import * as MatchGrade from './match-grade.ts'
import * as MatchQuery from './match-query.ts'
import {
  isSearchableResourceType,
  searchAllOfType,
  searchByIdentifiers,
  type SearchFailure,
} from './search-by-type.ts'
import type { MatchWithoutResource, PageTokenRepeated } from './search-pages.ts'

/**
 * Matching records against the store as FHIR's `$match` does, client side
 * and for every searchable type: queries in, graded candidates out, a whole
 * batch at once.
 *
 * @packageDocumentation
 */

/**
 * What a candidate was found by: `identifier`, a stored record carrying one
 * of the query's identifiers, or `name`, a stored record its type's rule
 * graded against the query's record.
 */
type Evidence = 'identifier' | 'name'

/**
 * A stored record a query matched, how well, and what it was found by.
 *
 * @typeParam TResourceType - The type of record the query was for
 */
interface Candidate<TResourceType extends ResourceType.Type = ResourceType.Type> {
  readonly resource: Extract<FhirResourceWithId, { readonly resourceType: TResourceType }>
  readonly grade: MatchGrade.Type
  readonly by: Evidence
}

/** What a match is asked for, as `$match` names its parameters. */
interface Options {
  /** Give candidates found by identifier only: no stored record is fetched to grade by name. */
  readonly onlyCertainMatches: boolean
  /** The most candidates given for one query, best grade first; `None` for every one. */
  readonly count: Option.Option<number>
}

/** What a match can fail with: any failed search. A failed search is not "no match". */
type Failure = SearchFailure | MatchWithoutResource | PageTokenRepeated

/** How many searches of different resource types run at once. */
const SEARCH_CONCURRENCY = 4

/**
 * The page size the name stage lists a type's stored records with: the most
 * the server gives in one page, so the list takes as few round trips as it
 * can.
 */
const STORED_PAGE_SIZE = 1000

/** Every resource type a record is matched by name as well as by identifier: one with a row in {@link nameRulesByType}. */
type NameRuledResourceType = 'Patient' | 'Practitioner'

/** What {@link nameRulesByType} holds for one resource type: how the name stage fetches its records, and how it grades them. */
interface NameRule<TResourceType extends NameRuledResourceType> {
  /** Every stored record of the type, which the name stage grades a query's record against. */
  readonly fetchStored: Effect.Effect<
    readonly FhirResourceWithId[],
    Failure,
    FhirR4ResourcesHttpApiClient
  >
  /** The grade `storedRecord` takes as a match of `queryRecord`; `None` when it is no match. */
  readonly grade: (
    queryRecord: MatchQuery.RecordOf<TResourceType>,
    storedRecord: MatchQuery.RecordOf<TResourceType>
  ) => Option.Option<MatchGrade.Type>
}

/**
 * Every {@link NameRuledResourceType}'s {@link NameRule}. A type without a
 * row is matched by identifier only.
 */
const nameRulesByType: {
  readonly [TResourceType in NameRuledResourceType]: NameRule<TResourceType>
} = {
  Patient: {
    fetchStored: searchAllOfType('Patient', { pageSize: STORED_PAGE_SIZE }),
    grade: MatchGrade.patientGradeOf,
  },
  Practitioner: {
    fetchStored: searchAllOfType('Practitioner', { pageSize: STORED_PAGE_SIZE }),
    grade: MatchGrade.practitionerGradeOf,
  },
}

/** Whether `resourceType` is a {@link NameRuledResourceType}: one with a row in the table. */
const isNameRuledResourceType = <TResourceType extends ResourceType.Type>(
  resourceType: TResourceType
): resourceType is TResourceType & NameRuledResourceType =>
  Object.hasOwn(nameRulesByType, resourceType)

/** Whether `resource` is of `resourceType`, narrowing it to that type's resource. */
const isOfType =
  <TResourceType extends ResourceType.Type>(resourceType: TResourceType) =>
  (
    resource: FhirResourceWithId
  ): resource is Extract<FhirResourceWithId, { readonly resourceType: TResourceType }> =>
    resource.resourceType === resourceType

/** Two stored resources are one when they have one literal reference. */
const sameStoredResource: Equivalence.Equivalence<FhirResourceWithId> = Equivalence.mapInput(
  Equivalence.string,
  literalReferenceOf
)

/** The key a record of `resourceType` carrying `identifier` is found under. */
const identifierKey = (
  resourceType: ResourceType.Type,
  identifier: IdentifierAndReference.QualifiedIdentifierType
): LogicalReference.Key => LogicalReference.key(LogicalReference.make(resourceType, identifier))

/** `identifiers` without repeats, by the token each is searched as. */
const distinctIdentifiers = (
  identifiers: Array.NonEmptyReadonlyArray<IdentifierAndReference.QualifiedIdentifierType>
): Array.NonEmptyReadonlyArray<IdentifierAndReference.QualifiedIdentifierType> =>
  Array.dedupeWith(
    identifiers,
    Equivalence.mapInput(Equivalence.string, TokenSearchParam.fromQualifiedIdentifier)
  )

/**
 * Every stored record carrying any identifier of `queries`: one
 * `searchByIdentifiers` per searchable type a query names an identifier of,
 * every identifier of every query of the type in it. A type with no such
 * identifier, and a type with no identifier search (`Binary`), sends nothing.
 */
const storedNamedBy = (
  queries: readonly MatchQuery.Type[]
): Effect.Effect<
  readonly FhirResourceWithId[],
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.map(
    Effect.forEach(
      Record.toEntries(Array.groupBy(queries, ({ resourceType }) => resourceType)),
      ([resourceType, queriesOfType]) =>
        Array.match(
          queriesOfType.flatMap(({ identifier }) => identifier),
          {
            onEmpty: () => Effect.succeed([]),
            onNonEmpty: (identifiers) =>
              isSearchableResourceType(resourceType)
                ? searchByIdentifiers(resourceType, distinctIdentifiers(identifiers))
                : Effect.succeed([]),
          }
        ),
      { concurrency: SEARCH_CONCURRENCY }
    ),
    Array.flatten
  )

/** `stored` under the key of every qualified identifier it carries ({@link identifierKey}). */
const indexByIdentifier = (
  stored: readonly FhirResourceWithId[]
): HashMap.HashMap<LogicalReference.Key, readonly FhirResourceWithId[]> =>
  Array.reduce(stored, HashMap.empty(), (index, resource) =>
    Array.reduce(MatchQuery.qualifiedIdentifiersOf(resource), index, (byKey, identifier) =>
      HashMap.modifyAt(byKey, identifierKey(resource.resourceType, identifier), (found) =>
        Option.some([...Option.getOrElse(found, () => []), resource])
      )
    )
  )

/** The stored records of `index` carrying any of `query`'s identifiers, each once, `certain`. */
const identifierCandidatesOf = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  index: HashMap.HashMap<LogicalReference.Key, readonly FhirResourceWithId[]>
): readonly Candidate<TResourceType>[] =>
  Array.dedupeWith(
    query.identifier.flatMap((identifier) =>
      Option.getOrElse(HashMap.get(index, identifierKey(query.resourceType, identifier)), () => [])
    ),
    sameStoredResource
  )
    .filter(isOfType(query.resourceType))
    .map((resource) => ({ resource, grade: 'certain', by: 'identifier' }))

/** Whether `resource` is a record of `resourceType`, narrowing it to that type's record. */
const isRecordOfType =
  <TResourceType extends ResourceType.Type>(resourceType: TResourceType) =>
  (resource: FhirResource): resource is MatchQuery.RecordOf<TResourceType> =>
    resource.resourceType === resourceType

/**
 * The grade `storedRecord` takes as a match of `queryRecord` by the rule of
 * `resourceType`; `None` when either is not of that type, or the rule finds
 * no match.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- one type, not the union, so the row read and the records narrowed to its type agree
const nameGradeOf = <TResourceType extends NameRuledResourceType>(
  resourceType: TResourceType,
  queryRecord: FhirResource,
  storedRecord: FhirResource
): Option.Option<MatchGrade.Type> => {
  const isOfRuledType = isRecordOfType(resourceType)
  return isOfRuledType(queryRecord) && isOfRuledType(storedRecord)
    ? nameRulesByType[resourceType].grade(queryRecord, storedRecord)
    : Option.none()
}

/**
 * Whether `query` goes on to the name stage: its type has a rule, it carries
 * its record, nothing was found for it by identifier, and more than certain
 * matches were asked for.
 */
const goesToNameStage = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  identifierCandidates: readonly Candidate<TResourceType>[],
  options: Options
): boolean =>
  !options.onlyCertainMatches &&
  identifierCandidates.length === 0 &&
  Option.isSome(query.record) &&
  isNameRuledResourceType(query.resourceType)

/**
 * Every stored record of each of `resourceTypes`, by type: one
 * {@link NameRule.fetchStored} per type, every page of it.
 */
const fetchStoredOfTypes = (
  resourceTypes: readonly NameRuledResourceType[]
): Effect.Effect<
  HashMap.HashMap<ResourceType.Type, readonly FhirResourceWithId[]>,
  Failure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.forEach(
    resourceTypes,
    (resourceType) =>
      Effect.map(
        nameRulesByType[resourceType].fetchStored,
        (stored) => [resourceType, stored] as const
      ),
    { concurrency: SEARCH_CONCURRENCY }
  ).pipe(Effect.map(HashMap.fromIterable))

/** The records of `storedOfType` its type's rule grades as matches of `query`'s record, `by: 'name'`. */
const nameCandidatesOf = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  storedOfType: readonly FhirResourceWithId[]
): readonly Candidate<TResourceType>[] => {
  const { resourceType } = query
  return Option.match(query.record, {
    onNone: () => [],
    onSome: (queryRecord) =>
      isNameRuledResourceType(resourceType)
        ? Array.filterMap(storedOfType.filter(isOfType(query.resourceType)), (resource) =>
            nameGradeOf(resourceType, queryRecord, resource).pipe(
              Option.map((grade) => ({ resource, grade, by: 'name' }))
            )
          )
        : [],
  })
}

/** `candidates` best grade first, as many as `count` allows. */
const bestCandidates = <TResourceType extends ResourceType.Type>(
  candidates: readonly Candidate<TResourceType>[],
  count: Option.Option<number>
): readonly Candidate<TResourceType>[] => {
  const ranked = Array.sortWith(candidates, ({ grade }) => grade, MatchGrade.bestFirst)
  return Option.match(count, { onNone: () => ranked, onSome: (most) => Array.take(ranked, most) })
}

/**
 * The stored records each of `queries` matches, graded, as `$match` answers,
 * in two stages: by identifier for every searchable type, then by name for a
 * query of a type with a rule ({@link nameRulesByType}) nothing was found
 * for by identifier.
 *
 * @remarks
 * The identifier stage takes one `searchByIdentifiers` per resource type for
 * the whole batch, every qualified identifier of every query of the type in
 * it, and a stored record is a `certain` candidate of every query whose
 * identifiers it carries. A query with no qualified identifier, and a type
 * with no identifier search (`Binary`), has no candidate by identifier and
 * sends nothing.
 *
 * Unless `onlyCertainMatches`, a query that carries its record, of a type
 * with a rule, with no candidate by identifier goes on to the name stage:
 * every stored record of its type is fetched (`searchAllOfType`, every page,
 * once per type for the whole batch) and the type's rule grades each against
 * the query's record, client side; one that grades as no match is dropped.
 * Only Patient and Practitioner have a rule; any other type is matched by
 * identifier only.
 *
 * Searches of different types run {@link SEARCH_CONCURRENCY} at a time. Any
 * failed search fails the match: it is not "no match".
 *
 * @param queries - The records to match
 * @param options - `onlyCertainMatches` and `count`, as `$match` takes them
 * @returns Each query's candidates, best grade first, then cut to `count`,
 *   in the order of `queries`
 */
const matchAll = <TResourceType extends ResourceType.Type>(
  queries: readonly MatchQuery.Type<TResourceType>[],
  options: Options
): Effect.Effect<
  readonly (readonly Candidate<TResourceType>[])[],
  Failure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.gen(function* () {
    const storedByIdentifier = indexByIdentifier(yield* storedNamedBy(queries))
    const identifierStage = queries.map((query) => {
      const identifierCandidates = identifierCandidatesOf(query, storedByIdentifier)
      return {
        query,
        identifierCandidates,
        toNameStage: goesToNameStage(query, identifierCandidates, options),
      }
    })
    const storedByType = yield* fetchStoredOfTypes(
      Array.dedupe(
        identifierStage
          .filter(({ toNameStage }) => toNameStage)
          .map(({ query }) => query.resourceType)
          .filter(isNameRuledResourceType)
      )
    )
    return identifierStage.map(({ query, identifierCandidates, toNameStage }) =>
      bestCandidates(
        [
          ...identifierCandidates,
          ...(toNameStage
            ? nameCandidatesOf(
                query,
                Option.getOrElse(HashMap.get(storedByType, query.resourceType), () => [])
              )
            : []),
        ],
        options.count
      )
    )
  })

export { matchAll }
export type { Candidate, Evidence, Failure, Options }
