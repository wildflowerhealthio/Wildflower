import { useMemo } from 'react'

import {
  useTraceExchangesQuery,
  type TraceExchangePage,
  type TraceExchangesQueryOptions,
} from '../queries/index.ts'
import { groupIntoSessions, type TraceSession } from './group-sessions.ts'

/**
 * What {@link useTraceSessions} hands the recordings tab.
 *
 * @remarks
 * `sessions` reflects the pages fetched so far, so a session's exchange count is
 * a lower bound while {@link TraceSessionsState.hasMore} is `true`. That is a
 * property of the data, not a shortcut: there is no server-side aggregate over
 * the session identifier, so an exact count is only knowable once every page has
 * been read.
 */
interface TraceSessionsState {
  /** The sessions grouped out of every page read so far, most recently active first. */
  readonly sessions: readonly TraceSession[]
  /** How many trace resources across those pages failed to decode. */
  readonly unreadableCount: number
  /** Whether the first page is still in flight. */
  readonly isPending: boolean
  /** Whether the server reported a further page. */
  readonly hasMore: boolean
  /** Whether a further page is in flight. */
  readonly isLoadingMore: boolean
  /** Fetches the next page. A no-op while one is in flight or when there is none. */
  readonly loadMore: () => void
  /** The read's failure, or `null`. */
  readonly error: Error | null
}

/** What {@link summarizePages} reduces a run of fetched pages to. */
interface PageSummary {
  /** The sessions grouped out of every page, most recently active first. */
  readonly sessions: readonly TraceSession[]
  /** The pages' unreadable counts, summed. */
  readonly unreadableCount: number
}

/**
 * Collapses the pages fetched so far into the sessions to render.
 *
 * @param pages - Every page delivered by the infinite query, in fetch order
 * @returns The grouped sessions and the running unreadable count
 *
 * @remarks
 * Grouping spans pages rather than running per page: one session's exchanges
 * routinely straddle a page boundary, so grouping a page at a time would list
 * the same session twice.
 */
const summarizePages = (pages: readonly TraceExchangePage[]): PageSummary => ({
  sessions: groupIntoSessions(pages.flatMap((page) => page.exchanges)),
  unreadableCount: pages.reduce((total, page) => total + page.unreadable, 0),
})

/**
 * Reads the device's recordings and groups them into sessions. The read comes
 * from {@link useTraceExchangesQuery}, which takes its authed runner from router
 * context.
 *
 * @param options - Page size, forwarded to the underlying read
 * @returns The sessions so far, the unreadable count, and the paging controls
 *
 * @remarks
 * Grouping is memoised on `data.pages`, whose identity changes with each new
 * page — so sessions appear incrementally rather than only after the whole
 * table has been paged, and an unrelated re-render re-sorts nothing.
 */
const useTraceSessions = (options?: TraceExchangesQueryOptions): TraceSessionsState => {
  const query = useTraceExchangesQuery(options)
  const pages = query.data?.pages

  const { sessions, unreadableCount } = useMemo(() => summarizePages(pages ?? []), [pages])

  return {
    sessions,
    unreadableCount,
    isPending: query.isPending,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: (): void => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage()
    },
    error: query.error,
  }
}

export { type PageSummary, summarizePages, useTraceSessions, type TraceSessionsState }
