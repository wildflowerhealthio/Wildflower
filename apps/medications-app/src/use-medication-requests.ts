import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  skipToken,
  useInfiniteQuery,
} from '@tanstack/react-query'
import { Effect } from 'effect'
import {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
  type SmartHandshake,
} from 'fhir-r4-react/smart'
import { type MedicationView, medicationRequestsToMedicationViews } from 'medication-core/fhir'
import { useMemo } from 'react'
import { useFetchEveryPage } from 'react-kitchen-sink'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

// The first page is opened with no patient in context; `fetchMedicationRequestPage`
// then reads across every patient the granted scopes expose (see its `null` case).
const initialCursor: MedicationRequestCursor = { patientId: null }

/** What {@link useMedicationRequests} hands the page. */
interface MedicationRequestRead {
  /** The paged read itself: its pages, paging flags and `fetchNextPage`. */
  readonly pagedQuery: UseInfiniteQueryResult<InfiniteData<MedicationRequestPage>>
  /** Every request landed so far, as a view, in server order. */
  readonly views: readonly MedicationView[]
}

/** Options for {@link useMedicationRequests}. */
interface MedicationRequestReadOptions {
  /** Whether to keep fetching until the last page lands ("load all the rest"). */
  readonly loadAll: boolean
}

/**
 * The paged MedicationRequest read, and what has landed as views.
 *
 * @param client - The SMART client, or `undefined` until the handshake completes.
 * @param options - {@link MedicationRequestReadOptions}.
 * @returns The read and its views.
 *
 * @remarks
 * A `useInfiniteQuery` whose cursor is the server's `next`-link URL,
 * `skipToken`-gated on the handshake resolving, which also narrows `client` to
 * defined inside the query function — no non-null assertion. Pages arrive
 * newest-authored first (server `_sort`), so appending each one never reorders
 * rows already on screen. While `loadAll` holds, `react-kitchen-sink`'s
 * `useFetchEveryPage` requests each next page until the last lands, halting on
 * a failed page — retry is an explicit user action, after which it resumes.
 * Otherwise pages load on demand (the page's scroll sentinel).
 */
const useMedicationRequests = (
  client: SmartClient | undefined,
  { loadAll }: MedicationRequestReadOptions
): MedicationRequestRead => {
  const pagedQuery = useInfiniteQuery({
    queryKey: ['medications'],
    // `pageParam` is annotated because the `skipToken` ternary blocks TanStack
    // from inferring the page-param type through it, which would otherwise narrow
    // it to only the first cursor variant.
    queryFn:
      client === undefined
        ? skipToken
        : ({ pageParam }: { readonly pageParam: MedicationRequestCursor }) =>
            Effect.runPromise(fetchMedicationRequestPage(client, pageParam)),
    initialPageParam: initialCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })
  useFetchEveryPage(pagedQuery, { enabled: loadAll })

  // `data` (and its `pages`) keeps a stable reference between renders unless a
  // page is added, so the mapping only re-runs when the loaded set actually grows.
  const pages = pagedQuery.data?.pages
  const views = useMemo(
    () => medicationRequestsToMedicationViews((pages ?? []).flatMap((page) => page.items)),
    [pages]
  )
  return { pagedQuery, views }
}

export { useMedicationRequests, type MedicationRequestRead, type MedicationRequestReadOptions }
