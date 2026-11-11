import type { TimelessDateFromString } from '@wildflowerhealthio/kitchen-sink/schema'
import {
  Array,
  Data,
  Effect,
  type Either,
  Equivalence,
  HashMap,
  Option,
  type ParseResult,
  Record,
  Schema,
} from 'effect'

import type { IdentifierAndReference } from '../data-types/index.ts'
import { type FhirResourceWithId, literalReferenceOf } from '../resources/fhir-resource-with-id.ts'
import * as LogicalReference from '../resources/logical-reference.ts'
import type * as ResourceType from '../resources/resource-type.ts'
import * as DateSearchParam from '../resources/search/date-search-param.ts'
import * as StringSearchParam from '../resources/search/string-search-param.ts'
import * as TokenSearchParam from '../resources/search/token-search-param.ts'
import type { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import * as MatchGrade from './match-grade.ts'
import * as MatchQuery from './match-query.ts'
import {
  isSearchableResourceType,
  searchByIdentifiers,
  type SearchFailure,
} from './search-by-type.ts'
import {
  type BatchSearch,
  type BatchSearchFailure,
  type BatchSubmitFailure,
  searchInBatch,
} from './search-in-batch.ts'
import type { MatchWithoutResource, PageTokenRepeated, SearchPages } from './search-pages.ts'

/**
 * Matching records against the store as FHIR's `Patient/$match` does,
 * client side and for every searchable type: queries in, graded candidates
 * out, a whole batch at once.
 *
 * @packageDocumentation
 */

/**
 * A stored record a query matched, and how well.
 *
 * @typeParam TResourceType - The type of record the query was for
 */
interface Candidate<TResourceType extends ResourceType.Type = ResourceType.Type> {
  readonly resource: Extract<FhirResourceWithId, { readonly resourceType: TResourceType }>
  readonly grade: MatchGrade.Type
}

/** What a match is asked for, as `$match` names its parameters. */
interface Options {
  /** Give `certain` candidates only: no search by name and birth date is sent. */
  readonly onlyCertainMatches: boolean
  /** The most candidates given for one query, best grade first; `None` for every one. */
  readonly count: Option.Option<number>
}

/**
 * A search by name and birth date: a Patient's family name and birth date, or
 * a Practitioner's family name. The family name is as {@link MatchGrade}
 * compares it.
 */
type DemographicSearch =
  | {
      readonly resourceType: 'Patient'
      readonly family: string
      readonly birthDate: typeof TimelessDateFromString.Type
    }
  | { readonly resourceType: 'Practitioner'; readonly family: string }

/**
 * The page size a search by name and birth date asks for: the most the server
 * gives in one page. Only the first page is read, so a search that continues
 * past it fails the match ({@link DemographicSearchPageFull}).
 */
const DEMOGRAPHIC_SEARCH_PAGE_SIZE = 1000

/**
 * A search by name and birth date that continued past its first page: it
 * matched more records than it gave, so candidates would be lost unseen.
 */
class DemographicSearchPageFull extends Data.TaggedError('DemographicSearchPageFull')<{
  readonly search: DemographicSearch
  readonly pageSize: number
}> {}

/** What a match can fail with: any failed search. A failed search is not "no match". */
type Failure =
  | SearchFailure
  | MatchWithoutResource
  | PageTokenRepeated
  | BatchSubmitFailure
  | BatchSearchFailure
  | ParseResult.ParseError
  | DemographicSearchPageFull

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
        )
    ),
    Array.flatten
  )

/** `stored` under the key of every qualified identifier it carries ({@link identifierKey}). */
const indexByIdentifier = (
  stored: readonly FhirResourceWithId[]
): HashMap.HashMap<LogicalReference.Key, readonly FhirResourceWithId[]> =>
  Array.reduce(stored, HashMap.empty(), (index, resource) =>
    Array.reduce(MatchQuery.fromResource(resource).identifier, index, (byKey, identifier) =>
      HashMap.modifyAt(byKey, identifierKey(resource.resourceType, identifier), (found) =>
        Option.some([...Option.getOrElse(found, () => []), resource])
      )
    )
  )

/** The stored records of `index` carrying any of `query`'s identifiers, each once. */
const certainCandidatesOf = <TResourceType extends ResourceType.Type>(
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
    .map((resource) => ({ resource, grade: 'certain' }))

/**
 * The searches by name and birth date that cast the net for `query`: for a
 * Patient with a birth date, one per family name its names have, with the
 * birth date; for a Practitioner, one per family name; none for any other
 * record, or a person with no family name.
 */
const demographicSearchesOf = (query: MatchQuery.Type): readonly DemographicSearch[] => {
  const families = Array.dedupe(
    MatchGrade.comparableNamesOf(query.name).map(({ family }) => family)
  )
  if (query.resourceType === 'Practitioner') {
    return families.map((family) => ({ resourceType: 'Practitioner', family }))
  }
  const { birthDate } = query
  return query.resourceType === 'Patient' && birthDate !== null
    ? families.map((family) => ({ resourceType: 'Patient', family, birthDate }))
    : []
}

/** One search's key: identical searches share it, so each is sent once. */
const demographicSearchKey = (search: DemographicSearch): string => JSON.stringify(search)

/** `search` as a search of a batch: `family` and, for a Patient, `birthdate`, a page's worth. */
const batchSearchOf = (
  search: DemographicSearch
): Effect.Effect<BatchSearch, ParseResult.ParseError> => {
  const family = StringSearchParam.escape(search.family)
  return search.resourceType === 'Patient'
    ? Effect.map(Schema.decode(DateSearchParam.Schema)(search.birthDate), (birthdate) => ({
        resourceType: 'Patient',
        urlParams: { family, birthdate, _count: DEMOGRAPHIC_SEARCH_PAGE_SIZE },
      }))
    : Effect.succeed({
        resourceType: 'Practitioner',
        urlParams: { family, _count: DEMOGRAPHIC_SEARCH_PAGE_SIZE },
      })
}

/**
 * The matches of one search of a batch, failing when its searchset continued
 * past its first page (`truncated`): the one place that decides whether an
 * answer left matches unread.
 */
const firstPageMatches = (
  search: DemographicSearch,
  answer: Either.Either<SearchPages<FhirResourceWithId>, BatchSearchFailure>
): Effect.Effect<readonly FhirResourceWithId[], BatchSearchFailure | DemographicSearchPageFull> =>
  Effect.flatMap(answer, ({ matches, truncated }) =>
    truncated
      ? Effect.fail(
          new DemographicSearchPageFull({ search, pageSize: DEMOGRAPHIC_SEARCH_PAGE_SIZE })
        )
      : Effect.succeed(matches)
  )

/**
 * The matches of every search of `searches`, by {@link demographicSearchKey}:
 * the distinct searches sent as one `searchInBatch` per resource type.
 */
const matchesOfDemographicSearches = (
  searches: readonly DemographicSearch[]
): Effect.Effect<
  HashMap.HashMap<string, readonly FhirResourceWithId[]>,
  Failure,
  FhirR4ResourcesHttpApiClient
> => {
  const distinct = Array.dedupeWith(
    searches,
    Equivalence.mapInput(Equivalence.string, demographicSearchKey)
  )
  return Effect.forEach(
    Record.values(Array.groupBy(distinct, ({ resourceType }) => resourceType)),
    (searchesOfType) =>
      Effect.gen(function* () {
        const batchSearches = yield* Effect.forEach(searchesOfType, batchSearchOf)
        const answers = yield* searchInBatch(batchSearches)
        return yield* Effect.forEach(Array.zip(searchesOfType, answers), ([search, answer]) =>
          Effect.map(
            firstPageMatches(search, answer),
            (matches) => [demographicSearchKey(search), matches] as const
          )
        )
      })
  ).pipe(Effect.map((byType) => HashMap.fromIterable(Array.flatten(byType))))
}

/** The candidates `searches`' matches give `query`, graded by name and birth date, each once. */
const demographicCandidatesOf = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  searches: readonly DemographicSearch[],
  matchesBySearch: HashMap.HashMap<string, readonly FhirResourceWithId[]>
): readonly Candidate<TResourceType>[] =>
  Array.dedupeWith(
    searches.flatMap((search) =>
      Option.getOrElse(HashMap.get(matchesBySearch, demographicSearchKey(search)), () => [])
    ),
    sameStoredResource
  )
    .filter(isOfType(query.resourceType))
    .flatMap((resource) =>
      Option.toArray(
        Option.map(
          MatchGrade.demographicGradeOf(query, MatchQuery.fromResource(resource)),
          (grade) => ({ resource, grade })
        )
      )
    )

/** `candidates` best grade first, as many as `count` allows. */
const bestCandidates = <TResourceType extends ResourceType.Type>(
  candidates: readonly Candidate<TResourceType>[],
  count: Option.Option<number>
): readonly Candidate<TResourceType>[] => {
  const ranked = Array.sortWith(candidates, ({ grade }) => grade, MatchGrade.bestFirst)
  return Option.match(count, { onNone: () => ranked, onSome: (most) => Array.take(ranked, most) })
}

/**
 * The stored records each of `queries` matches, graded, as `$match` answers:
 * `certain` by identifier for every searchable type, then `probable` and
 * `possible` by name and birth date for a person nothing matched for certain.
 *
 * @remarks
 * The certain matches take one `searchByIdentifiers` per resource type for
 * the whole batch, every qualified identifier of every query of the type in
 * it, and a stored record is a certain candidate of every query whose
 * identifiers it carries. A query with no qualified identifier, and a type
 * with no identifier search (`Binary`), has no certain candidate and sends
 * nothing.
 *
 * Unless `onlyCertainMatches`, a Patient or Practitioner query with no
 * certain candidate is then searched for by name and birth date
 * (`MatchGrade.demographicGradeOf` for the rules): a Patient by
 * `family` and `birthdate` (none without a birth date), a Practitioner by
 * `family`, one `searchInBatch` per type holding each distinct search once.
 * The server's string search casts the net (it reads `family` as "starts
 * with"); every match it returns is graded here, and one that grades as
 * neither is dropped. Only a search's first page is read: one whose searchset
 * links a next page fails as {@link DemographicSearchPageFull}.
 *
 * Any failed search fails the match: it is not "no match".
 *
 * @param queries - The records to match
 * @param options - `onlyCertainMatches` and `count`, as `$match` takes them
 * @returns Each query's candidates, best grade first, in the order of
 *   `queries`
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
    const withSearches = queries.map((query) => {
      const certain = certainCandidatesOf(query, storedByIdentifier)
      const searches =
        options.onlyCertainMatches || certain.length > 0 ? [] : demographicSearchesOf(query)
      return { query, certain, searches }
    })
    const matchesBySearch = yield* matchesOfDemographicSearches(
      withSearches.flatMap(({ searches }) => searches)
    )
    return withSearches.map(({ query, certain, searches }) =>
      bestCandidates(
        [...certain, ...demographicCandidatesOf(query, searches, matchesBySearch)],
        options.count
      )
    )
  })

export { DemographicSearchPageFull, matchAll }
export type { Candidate, DemographicSearch, Failure, Options }
