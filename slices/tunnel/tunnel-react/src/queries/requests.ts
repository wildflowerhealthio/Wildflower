import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query'
import { Effect, type Layer, Option, type Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from '../client/tunnel-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { tunnelRequestsPagesQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type LoggedRequest = Schema.Schema.Type<typeof Tunnel.LoggedRequestSchema>
type RequestLogPage = Schema.Schema.Type<typeof Tunnel.RequestLogPageSchema>
type RequestAuth = Schema.Schema.Type<typeof Tunnel.RequestAuthSchema>

/**
 * Which requests a request-log read keeps — `ListRequests`' url params without
 * the `cursor`, which the paging owns.
 */
type RequestLogFilter = Omit<
  Schema.Schema.Type<typeof Tunnel.ListRequestsUrlParamsSchema>,
  'cursor'
>

/** The `cursor` a request-log page is read from; `null` is the newest page. */
type RequestLogCursor = number | null

/** One `ListRequests` page under `filter`, read from `cursor`. */
const listRequestsPage = (
  filter: RequestLogFilter,
  cursor: RequestLogCursor
): Effect.Effect<RequestLogPage, unknown, Layer.Layer.Success<RuntimeLayer>> =>
  Effect.flatMap(TunnelAdminHttpApiClient, (c) =>
    c.tunnel.ListRequests({ urlParams: cursor === null ? filter : { ...filter, cursor } })
  ).pipe(Effect.provide(buildTunnelAdminClientLayer()))

/**
 * `ListRequests` under `filter`, newest first, one keyset page at a time. A
 * page whose `nextCursor` is `None` is the last, which TanStack Query reads from
 * the `null` {@link UseInfiniteQueryOptions.getNextPageParam} returns.
 */
const tunnelRequestsInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  filter: RequestLogFilter
): UseInfiniteQueryOptions<
  RequestLogPage,
  Error,
  InfiniteData<RequestLogPage, RequestLogCursor>,
  ReturnType<typeof tunnelRequestsPagesQueryKey>,
  RequestLogCursor
> =>
  infiniteQueryOptions({
    queryKey: tunnelRequestsPagesQueryKey(filter),
    initialPageParam: null as RequestLogCursor,
    getNextPageParam: (lastPage: RequestLogPage): RequestLogCursor =>
      Option.getOrNull(lastPage.nextCursor),
    queryFn: ({ pageParam }: { readonly pageParam: RequestLogCursor }) =>
      runAuthed(listRequestsPage(filter, pageParam)),
  })

const useTunnelRequestsQuery = (
  filter: RequestLogFilter
): UseInfiniteQueryResult<InfiniteData<RequestLogPage, RequestLogCursor>, Error> =>
  useInfiniteQuery(tunnelRequestsInfiniteQueryOptions(useRunAuthed(), filter))

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
  tunnelRequestsInfiniteQueryOptions,
  useExportRequestsMutation,
  useTunnelRequestsQuery,
}
export type { LoggedRequest, RequestAuth, RequestLogCursor, RequestLogFilter, RequestLogPage }
