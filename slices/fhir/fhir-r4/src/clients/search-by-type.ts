// oxlint-disable import/max-dependencies -- the table names each searchable type's search parameters schema, each its own module
import { Array, Effect, Option, type Schema } from 'effect'

import type { IdentifierAndReference } from '../data-types/index.ts'
import { SearchParams as CarePlanSearchParams } from '../resources/care-plan/search-params.ts'
import { SearchParams as DiagnosticReportSearchParams } from '../resources/diagnostic-report/search-params.ts'
import { SearchParams as DocumentReferenceSearchParams } from '../resources/document-reference/search-params.ts'
import { SearchParams as GoalSearchParams } from '../resources/goal/search-params.ts'
import { SearchParams as ImagingStudySearchParams } from '../resources/imaging-study/search-params.ts'
import { type FhirResourceWithId, literalReferenceOf } from '../resources/index.ts'
import { SearchParams as MedicationDispenseSearchParams } from '../resources/medication-dispense/search-params.ts'
import { SearchParams as MedicationRequestSearchParams } from '../resources/medication-request/search-params.ts'
import { SearchParams as ObservationSearchParams } from '../resources/observation/search-params.ts'
import { SearchParams as PatientSearchParams } from '../resources/patient/search-params.ts'
import { SearchParams as PlanDefinitionSearchParams } from '../resources/plan-definition/search-params.ts'
import { SearchParams as PractitionerSearchParams } from '../resources/practitioner/search-params.ts'
import { SearchParams as ProcedureSearchParams } from '../resources/procedure/search-params.ts'
import * as TokenSearchParam from '../resources/search/token-search-param.ts'
import { SearchParams as ServiceRequestSearchParams } from '../resources/service-request/search-params.ts'
import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesClientShape,
} from './fhir-r4-resources-http-api-client.ts'
import {
  type MatchWithoutResource,
  type PageTokenRepeated,
  searchAllPages,
  searchEveryPage,
  type SearchPages,
  type SearchsetPage,
} from './search-pages.ts'

/**
 * Searching any resource type the typed client can search by identifier,
 * indexed by the type: one table holds each type's search parameters schema
 * and its `POST <Type>/_search`, so a caller names a type rather than matching
 * over them.
 *
 * @packageDocumentation
 */

/** The search parameters the typed client's `POST <Type>/_search` takes for client group `Group`. */
type SearchParamsOfGroup<Group extends keyof FhirR4ResourcesClientShape> =
  FhirR4ResourcesClientShape[Group] extends {
    readonly Search: (request: { readonly payload: infer Params }) => unknown
  }
    ? Params
    : never

/**
 * Every resource type whose search parameters declare `identifier`: every
 * domain resource the typed client has a group for but `Binary`.
 *
 * @remarks
 * Derived from the client, so a type whose search parameters gain
 * `identifier` joins it, and the table of searches below fails to compile
 * until the type has its row.
 */
type SearchableResourceType = {
  readonly [Group in keyof FhirR4ResourcesClientShape]: FhirR4ResourcesClientShape[Group] extends {
    readonly Search: (request: { readonly payload: infer Params }) => unknown
  }
    ? 'identifier' extends keyof Params
      ? Group
      : never
    : never
}[keyof FhirR4ResourcesClientShape]

/** The search parameters of each {@link SearchableResourceType}, as its schema decodes them. */
type SearchParamsByType = {
  readonly [ResourceType in SearchableResourceType]: SearchParamsOfGroup<ResourceType>
}

/** A stored resource of `ResourceType`: the resource with its `id`, as a search answers with it. */
type SearchableResource<ResourceType extends SearchableResourceType> = Extract<
  FhirResourceWithId,
  { readonly resourceType: ResourceType }
>

/** What a search can fail with: the typed client's own failures, the same for every resource type. */
type SearchFailure = Effect.Effect.Error<
  ReturnType<FhirR4ResourcesClientShape[SearchableResourceType]['Search']>
>

/** The search parameters every searchable type shares: paging and `identifier`. */
interface SharedSearchParams {
  readonly _count?: number
  readonly _cursor?: string
  readonly identifier?: string
}

/** What the table holds for one resource type: its search parameters schema and its search. */
interface TypeSearch<ResourceType extends SearchableResourceType> {
  /** The schema the typed client encodes this type's search parameters with. */
  readonly searchParams: Schema.Schema<
    SearchParamsByType[ResourceType],
    Record<string, string | undefined>
  >
  /** One page of `POST <Type>/_search` through `client`, by the parameters every type shares. */
  readonly search: (
    client: FhirR4ResourcesClientShape,
    params: SharedSearchParams
  ) => Effect.Effect<SearchsetPage<SearchableResource<ResourceType>>, SearchFailure>
}

/** Every {@link SearchableResourceType}'s {@link TypeSearch}. */
const searchesByType: {
  readonly [ResourceType in SearchableResourceType]: TypeSearch<ResourceType>
} = {
  CarePlan: {
    searchParams: CarePlanSearchParams,
    search: (client, payload) => client.CarePlan.Search({ payload }),
  },
  DiagnosticReport: {
    searchParams: DiagnosticReportSearchParams,
    search: (client, payload) => client.DiagnosticReport.Search({ payload }),
  },
  DocumentReference: {
    searchParams: DocumentReferenceSearchParams,
    search: (client, payload) => client.DocumentReference.Search({ payload }),
  },
  Goal: {
    searchParams: GoalSearchParams,
    search: (client, payload) => client.Goal.Search({ payload }),
  },
  ImagingStudy: {
    searchParams: ImagingStudySearchParams,
    search: (client, payload) => client.ImagingStudy.Search({ payload }),
  },
  MedicationDispense: {
    searchParams: MedicationDispenseSearchParams,
    search: (client, payload) => client.MedicationDispense.Search({ payload }),
  },
  MedicationRequest: {
    searchParams: MedicationRequestSearchParams,
    search: (client, payload) => client.MedicationRequest.Search({ payload }),
  },
  Observation: {
    searchParams: ObservationSearchParams,
    search: (client, payload) => client.Observation.Search({ payload }),
  },
  Patient: {
    searchParams: PatientSearchParams,
    search: (client, payload) => client.Patient.Search({ payload }),
  },
  PlanDefinition: {
    searchParams: PlanDefinitionSearchParams,
    search: (client, payload) => client.PlanDefinition.Search({ payload }),
  },
  Practitioner: {
    searchParams: PractitionerSearchParams,
    search: (client, payload) => client.Practitioner.Search({ payload }),
  },
  Procedure: {
    searchParams: ProcedureSearchParams,
    search: (client, payload) => client.Procedure.Search({ payload }),
  },
  ServiceRequest: {
    searchParams: ServiceRequestSearchParams,
    search: (client, payload) => client.ServiceRequest.Search({ payload }),
  },
}

/** Whether `resourceType` is a {@link SearchableResourceType}: one with a row in the table. */
const isSearchableResourceType = (resourceType: string): resourceType is SearchableResourceType =>
  Object.hasOwn(searchesByType, resourceType)

/**
 * The page size a search for any of many values asks for: the most the
 * server gives in one page, so it takes as few round trips as it can.
 */
const ANY_OF_PAGE_SIZE = 1000

/**
 * How many values one search ORs together: well under the 1000 a single
 * parameter value fails at on HFS's SQLite backend.
 *
 * @remarks
 * HFS ORs a parameter's comma-joined values by nesting one expression level
 * per value, and SQLite refuses to prepare an expression deeper than 1000,
 * so a search for that many values in one parameter answers with a 500.
 */
const OR_VALUES_PER_SEARCH = 500

/** The paging parameters of one page of a search: its size, and the token that continues it. */
interface Paging {
  readonly _count: number
  readonly _cursor?: string
}

/**
 * `_cursor` as a search parameter: the token that continues a search, or
 * none for its first page.
 */
const cursorParam = (pageToken: Option.Option<string>): { readonly _cursor?: string } =>
  Option.match(pageToken, { onNone: () => ({}), onSome: (_cursor) => ({ _cursor }) })

/**
 * `resources` with each stored resource once, by its `Type/id`, at its first
 * position.
 */
const distinctByReference = <TResource extends FhirResourceWithId>(
  resources: readonly TResource[]
): readonly TResource[] => {
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const reference = literalReferenceOf(resource)
    if (seen.has(reference)) return false
    seen.add(reference)
    return true
  })
}

/**
 * Every stored resource of `resourceType` that any of `values` finds: one
 * search per chunk of {@link OR_VALUES_PER_SEARCH} values, each the page
 * `searchPage` asks for with that chunk, read page after page to the last
 * (`searchEveryPage`).
 *
 * @remarks
 * The chunks are searched one after another, and a resource two chunks find
 * is given once, by its `Type/id`. A match without its resource fails the
 * search (`MatchWithoutResource`), as does any failed page: a failed search
 * is not "no match".
 *
 * @param resourceType - The type of the resources searched
 * @param values - The values any of which finds a match, in the order they are chunked
 * @param searchPage - One page of the search for `chunk`, with `paging` spread into its parameters
 * @returns Every match, each once, in the order the server gave them
 */
const searchAnyOf = <ResourceType extends SearchableResourceType, Value>(
  resourceType: ResourceType,
  values: Array.NonEmptyReadonlyArray<Value>,
  searchPage: (
    client: FhirR4ResourcesClientShape,
    chunk: Array.NonEmptyReadonlyArray<Value>,
    paging: Paging
  ) => Effect.Effect<SearchsetPage<SearchableResource<ResourceType>>, SearchFailure>
): Effect.Effect<
  readonly SearchableResource<ResourceType>[],
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
    Effect.forEach(Array.chunksOf(values, OR_VALUES_PER_SEARCH), (chunk) =>
      searchEveryPage(resourceType, (pageToken) =>
        searchPage(client, chunk, { _count: ANY_OF_PAGE_SIZE, ...cursorParam(pageToken) })
      )
    )
  ).pipe(Effect.map((chunkMatches) => distinctByReference(chunkMatches.flat())))

/**
 * Every stored resource of `resourceType` carrying any of `identifiers`
 * ({@link searchAnyOf}): each search a `POST <Type>/_search` with
 * `identifier` the chunk's identifiers as one token value
 * (`TokenSearchParam.anyOf`).
 *
 * @remarks
 * A `POST` rather than a `GET`, since a search for hundreds of identifiers is
 * too long for a URL.
 *
 * @param resourceType - The type of the resources searched
 * @param identifiers - The identifiers any of which a match carries
 * @returns Every match, each once, in the order the server gave them
 */
const searchByIdentifiers = <ResourceType extends SearchableResourceType>(
  resourceType: ResourceType,
  identifiers: Array.NonEmptyReadonlyArray<IdentifierAndReference.QualifiedIdentifierType>
): Effect.Effect<
  readonly SearchableResource<ResourceType>[],
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  searchAnyOf(resourceType, identifiers, (client, chunk, paging) =>
    searchesByType[resourceType].search(client, {
      identifier: TokenSearchParam.anyOf(
        Array.map(chunk, TokenSearchParam.fromQualifiedIdentifier)
      ),
      ...paging,
    })
  )

/**
 * Every stored resource of `resourceType`, `pageSize` to a page, read page
 * after page to the last (`searchEveryPage`).
 *
 * @param resourceType - The type of the resources listed
 * @param options - `pageSize`: how many resources one page asks for
 * @returns The resources of every page, in page order
 */
const searchAllOfType = <ResourceType extends SearchableResourceType>(
  resourceType: ResourceType,
  options: { readonly pageSize: number }
): Effect.Effect<
  readonly SearchableResource<ResourceType>[],
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
    searchEveryPage(resourceType, (pageToken) =>
      searchesByType[resourceType].search(client, {
        _count: options.pageSize,
        ...cursorParam(pageToken),
      })
    )
  )

/**
 * The stored resources of `resourceType`, `pageSize` to a page, read page
 * after page up to `pageLimit` pages (`searchAllPages`), and whether the
 * limit left pages unread: a list offered as it is, said to be cut off.
 *
 * @param resourceType - The type of the resources listed
 * @param options - `pageSize`: how many resources one page asks for;
 *   `pageLimit`: how many pages are read at most
 * @returns The resources of the pages read, in page order, and whether the
 *   limit cut the list off
 */
const searchPagesOfType = <ResourceType extends SearchableResourceType>(
  resourceType: ResourceType,
  options: { readonly pageSize: number; readonly pageLimit: number }
): Effect.Effect<
  SearchPages<SearchableResource<ResourceType>>,
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
    searchAllPages(
      resourceType,
      (pageToken) =>
        searchesByType[resourceType].search(client, {
          _count: options.pageSize,
          ...cursorParam(pageToken),
        }),
      { pageLimit: options.pageLimit }
    )
  )

export {
  isSearchableResourceType,
  OR_VALUES_PER_SEARCH,
  searchAllOfType,
  searchAnyOf,
  searchPagesOfType,
  searchByIdentifiers,
  searchesByType,
}
export type {
  Paging,
  SearchableResource,
  SearchableResourceType,
  SearchFailure,
  SearchParamsByType,
}
