import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
} from '@tanstack/react-query'
import {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  type MedicationView,
  medicationRequestsToMedicationViews,
} from '@wildflowerhealthio/medication-core/fhir'
import {
  dedupeMedicationsByName,
  type Medication,
} from '@wildflowerhealthio/medication-sponsorship-core-js'
import type { ChunkBarPhase } from '@wildflowerhealthio/react-tundraish'
import {
  patientChoiceKeyOf,
  patientScopeOf,
  usePathPatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Effect, Match } from 'effect'
import { useCallback, useMemo } from 'react'

import { usePageState, useSmartClient } from '../router-context.ts'

/** The page's read of the open route's MedicationRequests, as the header and every tab see it. */
interface MedicationRead {
  /** The paged read itself: its pages, paging flags and `fetchNextPage`. */
  readonly pagedQuery: UseInfiniteQueryResult<InfiniteData<MedicationRequestPage>>
  /** Every request landed so far, as a view, in server order. */
  readonly views: readonly MedicationView[]
  /** How many pages have landed. */
  readonly pagesReceived: number
  /** Whether the read has run to its last page. */
  readonly listComplete: boolean
  /** Whether the reader has asked for every page; the page's driver reads them while it holds. */
  readonly everyPageRequested: boolean
  /** What the chunk bar shows: locked, failed, loading or idle. */
  readonly barPhase: ChunkBarPhase
  /**
   * Ask for every page ("load all the rest"), or, after a failed page, ask
   * for that page again.
   */
  readonly requestEveryPage: () => void
}

/**
 * The views of every request in `pages`, converted once per `pages` for the
 * whole page.
 *
 * @remarks
 * Every caller of {@link useMedicationRead} (the page, the open tab, the
 * partial-list banner) observes the one read, whose `pages` array is the same
 * reference for all of them until a page lands. Keyed on that array, the
 * conversion runs once per landed page rather than once per caller.
 */
const viewsByPages = new WeakMap<readonly MedicationRequestPage[], readonly MedicationView[]>()

/** The views of `pages`, from {@link viewsByPages}, converting them on first ask. */
const viewsOf = (pages: readonly MedicationRequestPage[]): readonly MedicationView[] => {
  const cached = viewsByPages.get(pages)
  if (cached !== undefined) return cached
  const views = medicationRequestsToMedicationViews(pages.flatMap((page) => page.items))
  viewsByPages.set(pages, views)
  return views
}

/** No request landed yet. */
const noViews: readonly MedicationView[] = []

/**
 * The MedicationRequests of the patient the path names, or of every patient,
 * read a page at a time, and what has landed as views.
 *
 * @remarks
 * A `useInfiniteQuery` keyed on the patient choice, whose first cursor is its
 * scope and every later one the server's `next`-link URL, so every caller
 * shares the one read on the page's query cache. Pages arrive
 * newest-authored first (server `_sort`), so appending each one never
 * reorders rows already on screen, and none is read again for the visit.
 * Pages load on demand (the Medications tab's scroll sentinel), or every one
 * of them once the reader asks
 * ({@link MedicationRead.requestEveryPage}): the page's driver then
 * requests each next page until the last lands, halting on a failed page,
 * which only the reader's retry resumes.
 */
const useMedicationRead = (): MedicationRead => {
  const client = useSmartClient()
  const patientChoice = usePathPatientChoice()
  const firstPageCursor: MedicationRequestCursor = { patientId: patientScopeOf(patientChoice) }
  const pagedQuery = useInfiniteQuery({
    queryKey: ['medications', patientChoiceKeyOf(patientChoice)],
    queryFn: ({ pageParam }: { readonly pageParam: MedicationRequestCursor }) =>
      Effect.runPromise(fetchMedicationRequestPage(client, pageParam)),
    initialPageParam: firstPageCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
    // Each tab observes the read as it opens; a tab change must not refetch
    // every page landed so far, so the read is never stale within a visit.
    staleTime: 'static',
  })
  const [everyPageRequested, updatePageState] = usePageState((state) => state.everyPageRequested)
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = pagedQuery

  const pages = pagedQuery.data?.pages
  const views = pages === undefined ? noViews : viewsOf(pages)
  const pagesReceived = pages?.length ?? 0
  const listComplete = pagesReceived > 0 && !hasNextPage

  const requestEveryPage = useCallback(() => {
    updatePageState({ everyPageRequested: true })
    // A failed later-page fetch halts the driver and nothing else clears the
    // error, so the request alone is inert when it is already set. Kick the
    // next fetch directly: React Query clears `isFetchNextPageError` on a
    // fresh attempt, which lets the driver resume from there.
    if (isFetchNextPageError) void fetchNextPage()
  }, [updatePageState, isFetchNextPageError, fetchNextPage])

  // `loading` covers both the scroll-triggered page pull and the driven
  // fetch-to-completion; the extra breathing block tracks either. A failed
  // page drops the bar back to idle: nothing is in flight until the retry.
  const barPhase: ChunkBarPhase = Match.value({
    listComplete,
    isFetchNextPageError,
    isFetchingNextPage,
    everyPageRequested,
  }).pipe(
    Match.when({ listComplete: true }, (): ChunkBarPhase => 'locked'),
    Match.when({ isFetchNextPageError: true }, (): ChunkBarPhase => 'error'),
    Match.when({ isFetchingNextPage: true }, (): ChunkBarPhase => 'loading'),
    Match.when({ everyPageRequested: true }, (): ChunkBarPhase => 'loading'),
    Match.orElse((): ChunkBarPhase => 'idle')
  )

  return {
    pagedQuery,
    views,
    pagesReceived,
    listComplete,
    everyPageRequested,
    barPhase,
    requestEveryPage,
  }
}

/**
 * The medications the patient currently takes: the active ones among
 * `views`, duplicate names collapsed to the most recent prescription. The
 * interactions report checks this list and Savings breaks it down, so the
 * two agree on what "your medications" means.
 */
const useCurrentMedications = (views: readonly MedicationView[]): readonly Medication[] =>
  useMemo(
    () =>
      dedupeMedicationsByName(
        views.flatMap((view) => (view.medication.status === 'active' ? [view.medication] : []))
      ),
    [views]
  )

export { useCurrentMedications, useMedicationRead }
export type { MedicationRead }
