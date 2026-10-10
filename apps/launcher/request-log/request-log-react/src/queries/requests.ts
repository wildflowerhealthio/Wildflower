import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Layer, Option, type Schema } from 'effect'
import { RequestLogHttpApiClient } from 'request-log-core-js/clients'
import type { RequestLog } from 'request-log-core-js/http-api-definition'

import { buildRequestLogClientLayer } from '../client/request-log-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { RECENT_REFUSED_REQUESTS_QUERY_KEY, requestsPagesQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type LoggedRequest = Schema.Schema.Type<typeof RequestLog.LoggedRequestSchema>
type RequestLogPage = Schema.Schema.Type<typeof RequestLog.RequestLogPageSchema>
type RequestAuth = Schema.Schema.Type<typeof RequestLog.RequestAuthSchema>

/**
 * Which requests a request-log read keeps — `ListRequests`' url params without
 * the `cursor`, which the paging owns.
 */
type RequestLogFilter = Omit<
  Schema.Schema.Type<typeof RequestLog.ListRequestsUrlParamsSchema>,
  'cursor'
>

/** The `cursor` a request-log page is read from; `null` is the newest page. */
type RequestLogCursor = number | null

/** One `ListRequests` page under `filter`, read from `cursor`. */
const listRequestsPage = (
  filter: RequestLogFilter,
  cursor: RequestLogCursor
): Effect.Effect<RequestLogPage, unknown, Layer.Layer.Success<RuntimeLayer>> =>
  Effect.flatMap(RequestLogHttpApiClient, (c) =>
    c.requestLog.ListRequests({ urlParams: cursor === null ? filter : { ...filter, cursor } })
  ).pipe(Effect.provide(buildRequestLogClientLayer()))

/**
 * `ListRequests` under `filter`, newest first, one keyset page at a time. A
 * page whose `nextCursor` is `None` is the last, which TanStack Query reads from
 * the `null` {@link UseInfiniteQueryOptions.getNextPageParam} returns.
 */
const requestsInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  filter: RequestLogFilter
): UseInfiniteQueryOptions<
  RequestLogPage,
  Error,
  InfiniteData<RequestLogPage, RequestLogCursor>,
  ReturnType<typeof requestsPagesQueryKey>,
  RequestLogCursor
> =>
  infiniteQueryOptions({
    queryKey: requestsPagesQueryKey(filter),
    initialPageParam: null as RequestLogCursor,
    getNextPageParam: (lastPage: RequestLogPage): RequestLogCursor =>
      Option.getOrNull(lastPage.nextCursor),
    queryFn: ({ pageParam }: { readonly pageParam: RequestLogCursor }) =>
      runAuthed(listRequestsPage(filter, pageParam)),
  })

const useRequestsQuery = (
  filter: RequestLogFilter
): UseInfiniteQueryResult<InfiniteData<RequestLogPage, RequestLogCursor>, Error> =>
  useInfiniteQuery(requestsInfiniteQueryOptions(useRunAuthed(), filter))

/**
 * The newest page of refused requests — what the activity card looks for
 * refused streaks in. One page (the server's page size) is enough: a streak is
 * a burst of recent refusals, and those are the newest.
 */
const recentRefusedRequestsQueryOptions = (
  runAuthed: RunAuthed
): UseQueryOptions<
  readonly LoggedRequest[],
  Error,
  readonly LoggedRequest[],
  typeof RECENT_REFUSED_REQUESTS_QUERY_KEY
> =>
  queryOptions({
    queryKey: RECENT_REFUSED_REQUESTS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        listRequestsPage({ auth: 'refused' }, null).pipe(Effect.map((page) => page.requests))
      ),
  })

const useRecentRefusedRequestsQuery = (): UseQueryResult<readonly LoggedRequest[], Error> =>
  useQuery(recentRefusedRequestsQueryOptions(useRunAuthed()))

/**
 * Every logged request under `filter`, newest first, read page by page to the
 * end of the log — the CSV export's read, which wants the whole filtered set
 * rather than the pages the table has shown.
 */
const listEveryRequest = (
  filter: RequestLogFilter
): Effect.Effect<readonly LoggedRequest[], unknown, Layer.Layer.Success<RuntimeLayer>> => {
  const readFrom = (
    cursor: RequestLogCursor,
    read: readonly LoggedRequest[]
  ): Effect.Effect<readonly LoggedRequest[], unknown, Layer.Layer.Success<RuntimeLayer>> =>
    Effect.flatMap(listRequestsPage(filter, cursor), (page) => {
      const requests = [...read, ...page.requests]
      return Option.match(page.nextCursor, {
        onNone: () => Effect.succeed(requests),
        onSome: (next) => readFrom(next, requests),
      })
    })
  return readFrom(null, [])
}

/**
 * Exports the request log under a filter; resolves with every matching
 * request (see {@link listEveryRequest}) for the caller to format and save.
 */
const useExportRequestsMutation = (): UseMutationResult<
  readonly LoggedRequest[],
  Error,
  RequestLogFilter
> => {
  const runAuthed = useRunAuthed()
  return useMutation({ mutationFn: (filter) => runAuthed(listEveryRequest(filter)) })
}

export {
  listEveryRequest,
  recentRefusedRequestsQueryOptions,
  requestsInfiniteQueryOptions,
  useExportRequestsMutation,
  useRecentRefusedRequestsQuery,
  useRequestsQuery,
}
export type { LoggedRequest, RequestAuth, RequestLogCursor, RequestLogFilter, RequestLogPage }
