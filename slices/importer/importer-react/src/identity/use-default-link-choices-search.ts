/**
 * The default link choice of every referent of a batch, searched once per
 * batch, and the stored lists the referent rows offer, started beside it.
 *
 * @remarks
 * Each referent's default is `ReferentSearch.defaultChoices`, a TanStack query
 * keyed by the batch id and read once per batch, over the referents of the
 * batch's first decode. The screen blocks the first paint on it, as it does on
 * the server diff, so every line paints with its search hit already chosen.
 * The stored lists the rows offer are read in the same breath (prefetched
 * under `storedResourcesQuery`), since they depend on neither.
 *
 * @packageDocumentation
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Array, Effect, HashMap, Option, pipe } from 'effect'
import { useEffect } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import {
  LinkableLogicalReference,
  LinkChoice,
  LinkableResource,
  type Referent,
  ReferentLinkChoices,
  ReferentSearch,
} from '@wildflowerhealthio/importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'
import {
  labeled,
  type StoredResource,
  storedResourcesQuery,
} from './use-stored-resources-of-type.ts'

/** What the default search answers with: the defaults, and the stored resources they link to, labelled. */
interface SearchedDefaults {
  readonly linkChoices: ReferentLinkChoices.Type
  readonly found: readonly StoredResource[]
}

const NO_DEFAULTS: SearchedDefaults = { linkChoices: ReferentLinkChoices.empty, found: [] }

/** The default choice of every referent of `referents`, and each stored resource those defaults link to or update, once. */
const searchDefaults = (
  referents: readonly Referent.Type[]
): Effect.Effect<
  SearchedDefaults,
  ReferentSearch.SearchFailure,
  Effect.Effect.Context<ReturnType<typeof ReferentSearch.defaultChoices>>
> =>
  Effect.gen(function* () {
    const linkChoices = yield* ReferentSearch.defaultChoices(referents)
    const found = yield* pipe(
      Array.fromIterable(HashMap.values(linkChoices)),
      Array.filterMap((choice) =>
        LinkChoice.is('LinkToStoredResource')(choice) ||
        LinkChoice.is('UpdateStoredResource')(choice)
          ? Option.some(choice.resource)
          : Option.none()
      ),
      Array.dedupeWith(
        (left, right) =>
          LinkableResource.literalReferenceOf(left) === LinkableResource.literalReferenceOf(right)
      ),
      Effect.forEach(labeled)
    )
    return { linkChoices, found }
  })

/** The default search as the review reads it: the defaults (none until they are in) and the query's status. */
interface DefaultLinkChoicesSearch {
  readonly defaults: SearchedDefaults
  readonly isPending: boolean
  readonly isError: boolean
  readonly error: Error | null
}

/**
 * The searched defaults of `searchedReferents`, read once for `batchId`, and
 * the stored lists of their types started.
 *
 * @param batchId - The picked batch's id, which keys the search
 * @param searchedReferents - The referents of the batch's first decode, or
 *   none while no batch is in hand
 * @returns The defaults and the search's status
 */
const useDefaultLinkChoicesSearch = (
  batchId: number,
  searchedReferents: readonly Referent.Type[]
): DefaultLinkChoicesSearch => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()

  // The stored lists the rows will offer start loading now, beside the
  // default search, rather than when the rows mount after it. A list that
  // fails is reported by the rows' own read of the same query, so this start
  // of it reports nothing.
  useEffect(() => {
    for (const resourceType of LinkableLogicalReference.RESOURCE_TYPES) {
      if (searchedReferents.some((referent) => referent.logicalReference.type === resourceType)) {
        queryClient.query(storedResourcesQuery(resourceType, runAuthed)).catch(() => undefined)
      }
    }
  }, [queryClient, runAuthed, searchedReferents])

  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'referent-defaults', batchId] as const,
    queryFn: (): Promise<SearchedDefaults> => runAuthed(searchDefaults(searchedReferents)),
    enabled: searchedReferents.length > 0,
    // The defaults are read once per batch; the batch is ephemeral.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  return {
    defaults: query.data ?? NO_DEFAULTS,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export { useDefaultLinkChoicesSearch }
