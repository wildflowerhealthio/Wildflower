import { useQuery } from '@tanstack/react-query'
import { Effect, Match, Option } from 'effect'
import { useMemo } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import { FhirR4ResourcesHttpApiClient, searchAllPages } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type LinkableLogicalReference,
  LinkableResource,
  type ReferentSearch,
} from '@wildflowerhealthio/importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'

/**
 * The server's stored Patients or Practitioners: what a referent's select
 * offers besides the search's hit, so the reviewer can link it to another
 * record.
 *
 * @remarks
 * Every page of `GET <Type>?_count=` through the typed client
 * (`fhir-r4/clients`' `searchAllPages`), read once when the referent rows
 * mount and capped at {@link STORED_PAGE_LIMIT} pages. A select has no room
 * for a "load more" action, and a personal server holds a household's worth
 * of people and their providers, not a hospital's, so the whole list is read
 * up front and offered at once. Each resource arrives with the label the
 * review shows it by, read on the clock the read runs on.
 *
 * @packageDocumentation
 */

/** How many stored resources one page requests. */
const STORED_PAGE_SIZE = 50

/** How many pages are read before the list is offered as it is. */
const STORED_PAGE_LIMIT = 10

/** A stored resource with the label the review shows it by. */
interface StoredResource {
  readonly resource: LinkableResource.WithId
  readonly label: string
}

/** `resource` with its label: its displayed name and birth date, else its literal reference. */
const labeled = (resource: LinkableResource.WithId): Effect.Effect<StoredResource> =>
  Effect.map(
    LinkableResource.labelOf(resource, LinkableResource.literalReferenceOf(resource)),
    (label) => ({ resource, label })
  )

/** The request for one page of a stored list: `pageToken` continues it, `None` asks for the first. */
const pageRequest = (
  pageToken: Option.Option<string>
): { readonly urlParams: { readonly _count: number; readonly _pageToken?: string } } => ({
  urlParams: {
    _count: STORED_PAGE_SIZE,
    ...Option.match(pageToken, {
      onNone: () => ({}),
      onSome: (_pageToken) => ({ _pageToken }),
    }),
  },
})

/** Every stored resource of `resourceType`, page after page, up to {@link STORED_PAGE_LIMIT} pages. */
const storedResources = (
  resourceType: LinkableLogicalReference.ResourceType
): Effect.Effect<
  readonly LinkableResource.WithId[],
  ReferentSearch.SearchFailure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
    Match.value(resourceType).pipe(
      Match.when('Patient', () =>
        searchAllPages((pageToken) => client.Patient.SearchByGet(pageRequest(pageToken)), {
          pageLimit: STORED_PAGE_LIMIT,
        })
      ),
      Match.when('Practitioner', () =>
        searchAllPages((pageToken) => client.Practitioner.SearchByGet(pageRequest(pageToken)), {
          pageLimit: STORED_PAGE_LIMIT,
        })
      ),
      Match.exhaustive
    )
  )

/**
 * The stored list as the rows read it: `loading` until the pages are in,
 * `ready` with every resource labelled, `error` when a page failed, which the
 * rows say rather than offering a shorter list as if it were the whole one.
 */
type StoredResourcesState =
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'ready'; readonly resources: readonly StoredResource[] }
  | { readonly _tag: 'error'; readonly error: Error }

const LOADING: StoredResourcesState = { _tag: 'loading' }

/**
 * The server's stored resources of `resourceType`, each with its label.
 *
 * @param resourceType - Patient or Practitioner
 * @param enabled - Whether to read at all: false when the batch has no
 *   referent of that type
 * @returns The list's state
 *
 * @remarks
 * Read once for as long as the rows are mounted (`staleTime: Infinity`, so
 * a window focus does not page through the server again) and dropped when
 * they unmount (`gcTime: 0`), so the next review reads the records the last
 * one wrote.
 */
const useStoredResources = (
  resourceType: LinkableLogicalReference.ResourceType,
  enabled: boolean
): StoredResourcesState => {
  const runAuthed = useRunAuthed()
  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'stored', resourceType] as const,
    queryFn: (): Promise<readonly StoredResource[]> =>
      runAuthed(Effect.flatMap(storedResources(resourceType), Effect.forEach(labeled))),
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  return useMemo((): StoredResourcesState => {
    if (query.data !== undefined) return { _tag: 'ready', resources: query.data }
    if (query.isError) {
      return {
        _tag: 'error',
        error:
          query.error instanceof Error
            ? query.error
            : new Error(`Failed to list the server's ${resourceType} resources`),
      }
    }
    return LOADING
  }, [query.data, query.isError, query.error, resourceType])
}

export { labeled, type StoredResource, type StoredResourcesState, useStoredResources }
