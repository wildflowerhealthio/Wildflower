import { Array, Effect, Equivalence, HashMap, Option, pipe, Record, Schema } from 'effect'

import type { IdentifierAndReference } from '../data-types/index.ts'
import { type FhirResourceWithId, literalReferenceOf } from '../resources/fhir-resource-with-id.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
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
  searchAnyOf,
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

/** Every resource type a record is matched by name as well as by identifier: one with a row in {@link nameRulesByType}. */
type NameRuledResourceType = 'Patient' | 'Practitioner'

/** What the name stage's search for one type finds: the stored records it grades the queries' records against. */
type NameStageSearch = Effect.Effect<
  readonly FhirResourceWithId[],
  Failure,
  FhirR4ResourcesHttpApiClient
>

/** What {@link nameRulesByType} holds for one resource type: how the name stage searches its records, and how it grades them. */
interface NameRule<TResourceType extends NameRuledResourceType> {
  /**
   * The stored records `queryRecords` are graded against: every stored
   * record any of them can grade as a match, and others, which grade as no
   * match. Nothing is sent when no query record gives a value to search by.
   */
  readonly searchGradable: (
    queryRecords: readonly MatchQuery.RecordOf<TResourceType>[]
  ) => NameStageSearch
  /** Whether `queryRecord` can grade any stored record: when not, nothing is fetched for it. */
  readonly canGrade: (queryRecord: MatchQuery.RecordOf<TResourceType>) => boolean
  /** The grade `storedRecord` takes as a match of `queryRecord`; `None` when it is no match. */
  readonly grade: (
    queryRecord: MatchQuery.RecordOf<TResourceType>,
    storedRecord: MatchQuery.RecordOf<TResourceType>
  ) => Option.Option<MatchGrade.Type>
}

/**
 * `values` searched by `search` ({@link searchAnyOf}), or nothing sent and
 * nothing found when there are none.
 */
const searchUnlessEmpty = <Value>(
  values: readonly Value[],
  search: (values: Array.NonEmptyReadonlyArray<Value>) => NameStageSearch
): NameStageSearch => (Array.isNonEmptyReadonlyArray(values) ? search(values) : Effect.succeed([]))

/**
 * Every stored Patient born on a birth date of `queryRecords`: a
 * `birthdate` search ORing the distinct dates (`DateSearchParam.AnyOf`), a
 * chunk of them at a time ({@link searchAnyOf}), no name sent. Every Patient grade needs equal birth dates, so this finds
 * every stored Patient that can grade, however the names are written.
 */
const searchPatientsBornOn = (
  queryRecords: readonly MatchQuery.RecordOf<'Patient'>[]
): NameStageSearch =>
  searchUnlessEmpty(
    pipe(
      Array.dedupe(
        Array.filterMap(queryRecords, ({ birthDate }) => Option.fromNullable(birthDate))
      ),
      Array.filterMap((birthDate) => Schema.decodeOption(DateSearchParam.Schema)(birthDate))
    ),
    (birthDates) =>
      searchAnyOf('Patient', birthDates, (client, birthdate, paging) =>
        client.Patient.Search({ payload: { birthdate, ...paging } })
      )
  )

/**
 * Every stored Practitioner with a name starting with a family name word of
 * `queryRecords` ({@link MatchGrade.familySearchWordsOf}): a `name` search
 * ORing the distinct words (`StringSearchParam.anyOf`), a chunk of them at a
 * time ({@link searchAnyOf}), no given name sent,
 * since every Practitioner grade needs equal family names.
 *
 * @remarks
 * HFS indexes a name's family, each given name and its text as separate
 * values, folded to lower case without accents, and a `name` value finds a
 * record when any of them starts with it. So `brown` finds the family names
 * "Brown" and "Browning", but not a stored name written only as text ("DR J
 * BROWN"), which the rule could grade: such a record is not found by the
 * name stage, unless another of its names is.
 */
const searchPractitionersByFamily = (
  queryRecords: readonly MatchQuery.RecordOf<'Practitioner'>[]
): NameStageSearch =>
  searchUnlessEmpty(
    Array.dedupe(queryRecords.flatMap(({ name }) => MatchGrade.familySearchWordsOf(name))),
    (familyWords) =>
      searchAnyOf('Practitioner', familyWords, (client, words, paging) =>
        client.Practitioner.Search({ payload: { name: StringSearchParam.anyOf(words), ...paging } })
      )
  )

/**
 * Every {@link NameRuledResourceType}'s {@link NameRule}. A type without a
 * row is matched by identifier only.
 */
const nameRulesByType: {
  readonly [TResourceType in NameRuledResourceType]: NameRule<TResourceType>
} = {
  Patient: {
    searchGradable: searchPatientsBornOn,
    canGrade: MatchGrade.canGradePatient,
    grade: MatchGrade.patientGradeOf,
  },
  Practitioner: {
    searchGradable: searchPractitionersByFamily,
    canGrade: MatchGrade.canGradePractitioner,
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
 * Fetches every stored record carrying any identifier of `queries`: one
 * `searchByIdentifiers` per searchable type a query names an identifier of,
 * every identifier of every query of the type in it, the types
 * {@link SEARCH_CONCURRENCY} at a time. A type with no such identifier, and
 * a type with no identifier search (`Binary`), sends nothing.
 */
const fetchStoredByIdentifiers = (
  queries: readonly MatchQuery.Type[]
): Effect.Effect<readonly FhirResourceWithId[], Failure, FhirR4ResourcesHttpApiClient> =>
  pipe(
    Array.groupBy(queries, ({ resourceType }) => resourceType),
    Record.toEntries,
    Array.filterMap(([resourceType, queriesOfType]) =>
      Option.all([
        Option.liftPredicate(resourceType, isSearchableResourceType),
        Option.liftPredicate(
          queriesOfType.flatMap(({ identifier }) => identifier),
          Array.isNonEmptyReadonlyArray<IdentifierAndReference.QualifiedIdentifierType>
        ),
      ])
    ),
    (searches) =>
      Effect.forEach(
        searches,
        ([resourceType, identifiers]) =>
          searchByIdentifiers(resourceType, distinctIdentifiers(identifiers)),
        { concurrency: SEARCH_CONCURRENCY }
      ),
    Effect.map(Array.flatten)
  )

/** The keys `resource` is found under: one per qualified identifier it carries ({@link identifierKey}). */
const identifierKeysOf = (resource: FhirResourceWithId): readonly LogicalReference.Key[] =>
  MatchQuery.qualifiedIdentifiersOf(resource).map((identifier) =>
    identifierKey(resource.resourceType, identifier)
  )

/** The stored records found under each key, every record of `stored` under its {@link identifierKeysOf}. */
type IdentifierIndex = Record.ReadonlyRecord<string, readonly FhirResourceWithId[]>

/** `stored` under the key of every qualified identifier it carries ({@link identifierKeysOf}). */
const indexByIdentifier = (stored: readonly FhirResourceWithId[]): IdentifierIndex =>
  pipe(
    stored,
    Array.flatMap((resource) => identifierKeysOf(resource).map((key) => [key, resource] as const)),
    Array.groupBy(([key]) => key),
    Record.map(Array.map(([, resource]) => resource))
  )

/**
 * The grade a candidate found by identifier takes: `certain` when it is the
 * only one its query has, `probable` when the query's identifiers name
 * several stored records, since a record has one stored copy and the store
 * cannot say which it is.
 */
const identifierGradeOf = (candidateCount: number): MatchGrade.Type =>
  candidateCount > 1 ? 'probable' : 'certain'

/**
 * The stored records of `index` carrying any of `query`'s identifiers, each
 * once, graded by how many there are ({@link identifierGradeOf}).
 */
const identifierCandidatesOf = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  index: IdentifierIndex
): readonly Candidate<TResourceType>[] => {
  const found = pipe(
    query.identifier,
    Array.flatMap((identifier) =>
      Record.get(index, identifierKey(query.resourceType, identifier)).pipe(
        Option.getOrElse(() => [])
      )
    ),
    Array.dedupeWith(sameStoredResource),
    Array.filter(isOfType(query.resourceType))
  )
  const grade = identifierGradeOf(found.length)
  return found.map((resource) => ({ resource, grade, by: 'identifier' }))
}

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
 * Whether `queryRecord` can grade any stored record by the rule of
 * `resourceType` ({@link NameRule.canGrade}); `false` when it is not of that
 * type.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- one type, not the union, so the row read and the record narrowed to its type agree
const canGradeByName = <TResourceType extends NameRuledResourceType>(
  resourceType: TResourceType,
  queryRecord: FhirResource
): boolean =>
  isRecordOfType(resourceType)(queryRecord) && nameRulesByType[resourceType].canGrade(queryRecord)

/**
 * Whether `query` goes on to the name stage: its type has a rule, it carries
 * a record that rule can grade by, nothing was found for it by identifier,
 * and more than certain matches were asked for.
 */
const goesToNameStage = <TResourceType extends ResourceType.Type>(
  query: MatchQuery.Type<TResourceType>,
  identifierCandidates: readonly Candidate<TResourceType>[],
  options: Options
): boolean => {
  const { resourceType } = query
  return (
    !options.onlyCertainMatches &&
    identifierCandidates.length === 0 &&
    isNameRuledResourceType(resourceType) &&
    Option.exists(query.record, (queryRecord) => canGradeByName(resourceType, queryRecord))
  )
}

/**
 * The stored records the rule of `resourceType` grades the records of
 * `queryRecords` of that type against ({@link NameRule.searchGradable}).
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- one type, not the union, so the row read and the records narrowed to its type agree
const searchGradableOfType = <TResourceType extends NameRuledResourceType>(
  resourceType: TResourceType,
  queryRecords: readonly FhirResource[]
): NameStageSearch =>
  nameRulesByType[resourceType].searchGradable(queryRecords.filter(isRecordOfType(resourceType)))

/**
 * The stored records each type of `queries` is graded against, by type: one
 * {@link NameRule.searchGradable} per type, with the records of every query
 * of the type, the types {@link SEARCH_CONCURRENCY} at a time.
 */
const searchGradableByType = (
  queries: readonly MatchQuery.Type[]
): Effect.Effect<
  HashMap.HashMap<ResourceType.Type, readonly FhirResourceWithId[]>,
  Failure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.forEach(
    Array.dedupe(queries.map(({ resourceType }) => resourceType).filter(isNameRuledResourceType)),
    (resourceType) =>
      Effect.map(
        searchGradableOfType(
          resourceType,
          Array.filterMap(queries, ({ record }) => record)
        ),
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
 * identifiers it carries; a query whose identifiers name several stored
 * records has each as a `probable` candidate instead. A query with no
 * qualified identifier, and a type with no identifier search (`Binary`), has
 * no candidate by identifier and sends nothing.
 *
 * Unless `onlyCertainMatches`, a query that carries its record, of a type
 * with a rule that can grade by it (a Patient with a birth date and a
 * family name, a Practitioner with a family name), with no candidate by
 * identifier goes on to the name stage:
 * its type's row searches the stored records it can grade against, one
 * search set per type for the whole batch built from every such query of the
 * type (Patients by any of their birth dates, Practitioners by any of their
 * family name words), and the type's rule grades each found record against
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
    const storedByIdentifier = indexByIdentifier(yield* fetchStoredByIdentifiers(queries))
    const identifierStage = queries.map((query) => {
      const identifierCandidates = identifierCandidatesOf(query, storedByIdentifier)
      return {
        query,
        identifierCandidates,
        toNameStage: goesToNameStage(query, identifierCandidates, options),
      }
    })
    const storedByType = yield* searchGradableByType(
      identifierStage.filter(({ toNameStage }) => toNameStage).map(({ query }) => query)
    )
    return identifierStage.map(({ query, identifierCandidates, toNameStage }) =>
      bestCandidates(
        [
          ...identifierCandidates,
          ...(toNameStage
            ? nameCandidatesOf(
                query,
                HashMap.get(storedByType, query.resourceType).pipe(Option.getOrElse(() => []))
              )
            : []),
        ],
        options.count
      )
    )
  })

export { matchAll }
export type { Candidate, Evidence, Failure, Options }
