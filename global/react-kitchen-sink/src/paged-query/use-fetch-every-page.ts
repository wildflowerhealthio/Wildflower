import { useEffect } from 'react'

import type { PagedQuery } from './paged-query.ts'

/** Options for {@link useFetchEveryPage}. */
interface FetchEveryPageOptions {
  /**
   * Whether to keep fetching. Defaults to `true`; `false` holds the read at
   * the pages it has, and turning it back on resumes from there.
   */
  readonly enabled?: boolean
}

/**
 * Keep requesting a paged read's next page until its last one lands, so the
 * whole read loads with no scroll sentinel or "more" button driving it.
 *
 * @param pagedQuery - The read to drain, e.g. a `useInfiniteQuery` result.
 * @param options - {@link FetchEveryPageOptions}; left out, it drains at once.
 *
 * @remarks
 * An effect rather than a loop, so it rides the query's own in-flight dedupe:
 * StrictMode's double-mount asks for a page once, not twice. It waits for the
 * first page (which the query fetches itself), never asks while a page is in
 * flight, and halts on a failed page rather than hammering it — asking again
 * is the caller's call (`fetchNextPage`), after which the drain resumes.
 *
 * The number of pages landed is a dependency on purpose: a page can land
 * within a single commit, never showing `isFetchingNextPage`, and the count is
 * the one input guaranteed to change per page, so the drain cannot stall.
 *
 * There is no cancelling cleanup: one would fire on StrictMode's dev
 * double-mount and abort the first page's own fetch. The drain is bounded by
 * `hasNextPage` (the last page ends it) and `isFetchNextPageError` (a failed
 * page halts it). Aborting an in-flight page belongs on the query function's
 * own `signal`.
 */
const useFetchEveryPage = <TPage>(
  pagedQuery: PagedQuery<TPage>,
  { enabled = true }: FetchEveryPageOptions = {}
): void => {
  const pagesLanded = pagedQuery.data?.pages.length ?? 0
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = pagedQuery
  useEffect(() => {
    if (enabled && pagesLanded > 0 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage()
    }
  }, [enabled, pagesLanded, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])
}

export { useFetchEveryPage, type FetchEveryPageOptions }
