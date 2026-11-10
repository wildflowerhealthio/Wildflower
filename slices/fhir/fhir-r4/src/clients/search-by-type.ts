// oxlint-disable import/max-dependencies -- the table names each searchable type's search parameters schema, each its own module
import { Array, Effect, Option, type Schema } from 'effect'

import type { IdentifierAndReference } from '../data-types/index.ts'
import { SearchParams as CarePlanSearchParams } from '../resources/care-plan/search-params.ts'
import { SearchParams as DiagnosticReportSearchParams } from '../resources/diagnostic-report/search-params.ts'
import { SearchParams as DocumentReferenceSearchParams } from '../resources/document-reference/search-params.ts'
import { SearchParams as GoalSearchParams } from '../resources/goal/search-params.ts'
import { SearchParams as ImagingStudySearchParams } from '../resources/imaging-study/search-params.ts'
import type { FhirResourceWithId } from '../resources/index.ts'
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
  readonly _pageToken?: string
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

/**
 * The page size an identifier search asks for: the most the server gives in
 * one page, so a search for many identifiers takes as few round trips as it
 * can.
 */
const IDENTIFIER_SEARCH_PAGE_SIZE = 1000

/**
 * `_pageToken` as a search parameter: the token that continues a search, or
 * none for its first page.
 */
const pageTokenParam = (pageToken: Option.Option<string>): { readonly _pageToken?: string } =>
  Option.match(pageToken, { onNone: () => ({}), onSome: (_pageToken) => ({ _pageToken }) })

/**
 * Every stored resource of `resourceType` carrying any of `identifiers`: one
 * `POST <Type>/_search` with `identifier` the identifiers as one token value
 * (`TokenSearchParam.anyOf`), page after page to the last.
 *
 * @remarks
 * A `POST` rather than a `GET`, since a search for thousands of identifiers
 * is too long for a URL. A match without its resource fails the search
 * (`MatchWithoutResource`), as does any failed page: a failed search is not
 * "no match".
 *
 * @param resourceType - The type of the resources searched
 * @param identifiers - The identifiers any of which a match carries
 * @returns Every match, in the order the server gave them
 */
const searchByIdentifiers = <ResourceType extends SearchableResourceType>(
  resourceType: ResourceType,
  identifiers: Array.NonEmptyReadonlyArray<IdentifierAndReference.QualifiedIdentifierType>
): Effect.Effect<
  readonly SearchableResource<ResourceType>[],
  SearchFailure | MatchWithoutResource | PageTokenRepeated,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) => {
    const identifier = TokenSearchParam.anyOf(
      Array.map(identifiers, TokenSearchParam.fromQualifiedIdentifier)
    )
    return searchEveryPage(resourceType, (pageToken) =>
      searchesByType[resourceType].search(client, {
        identifier,
        _count: IDENTIFIER_SEARCH_PAGE_SIZE,
        ...pageTokenParam(pageToken),
      })
    )
  })

/**
 * Every stored resource of `resourceType`, `pageSize` to a page, up to
 * `pageLimit` pages, as `searchAllPages` reads them.
 *
 * @param resourceType - The type of the resources listed
 * @param options - `pageSize`: how many resources one page asks for;
 *   `pageLimit`: how many pages are read before the list is given as it is
 * @returns The resources of every page read, in page order, and whether the
 *   page limit left pages unread
 */
const searchAllOfType = <ResourceType extends SearchableResourceType>(
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
          ...pageTokenParam(pageToken),
        }),
      { pageLimit: options.pageLimit }
    )
  )

export { searchAllOfType, searchByIdentifiers, searchesByType }
export type { SearchableResource, SearchableResourceType, SearchFailure, SearchParamsByType }
