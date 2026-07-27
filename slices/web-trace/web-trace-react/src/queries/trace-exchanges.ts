import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'
import { Effect, Option } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import { useRunAuthed } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { TraceExchange } from 'web-trace-core'
import {
  fromDocumentReference,
  isWebTrace,
  WEB_TRACE_CATEGORY_CODE,
  WEB_TRACE_CODE_SYSTEM,
  type DocumentReferenceType,
} from 'web-trace-core/codec'

import { TRACE_EXCHANGES_QUERY_KEY } from './keys.ts'
import { nextPageToken, type PageLink } from './page-token.ts'

/**
 * The paged read behind the recordings tab: trace `DocumentReference`s off the
 * device's own FHIR server, decoded back into {@link TraceExchange}s.
 *
 * @remarks
 * The search is by `category`, which is the axis a trace is reachable on —
 * traces carry no `subject`, so they are deliberately invisible to a
 * patient-centred read. There is no server-side aggregate over `identifier`, so
 * sessions cannot be listed directly; they are grouped out of these pages by
 * `groupIntoSessions`.
 *
 * @packageDocumentation
 */

/**
 * The `category` token the search filters on, in FHIR's `system|code` form so a
 * bare `web-trace` code in some other system cannot match.
 *
 * @remarks
 * Built from `web-trace-core`'s constants rather than spelled out: the codec
 * writes this coding, and a second literal here would drift from it the moment
 * either moved.
 */
const WEB_TRACE_CATEGORY_TOKEN = `${WEB_TRACE_CODE_SYSTEM}|${WEB_TRACE_CATEGORY_CODE}`

/**
 * How many `DocumentReference`s one page requests.
 *
 * @remarks
 * A page is one round trip and one grouping pass, and the sessions list
 * re-renders after each. Large enough that a modest session arrives in one or
 * two pages, small enough that the first rows paint quickly on a device holding
 * many recorded sessions.
 */
const DEFAULT_PAGE_SIZE = 50

/** One page of decoded exchanges, plus what the page could not read. */
interface TraceExchangePage {
  /** Every trace resource on the page that decoded, in the order the server sent them. */
  readonly exchanges: readonly TraceExchange[]
  /**
   * How many trace resources on this page failed to decode.
   *
   * @remarks
   * Counts only resources that claim the web-trace category — a
   * `DocumentReference` from some other category is not a failed trace, it is
   * not a trace at all, and is dropped without being counted.
   */
  readonly unreadable: number
  /** The cursor for the following page, or `undefined` at the end of the searchset. */
  readonly nextPageToken: string | undefined
}

/** The cursor type paging carries; `null` is the first page, not a page named null. */
type TracePageParam = string | null

/** Query key for the paged read, distinguished by page size. */
type TraceExchangesQueryKey = readonly [
  ...typeof TRACE_EXCHANGES_QUERY_KEY,
  { readonly pageSize: number },
]

/** Options for {@link traceExchangesInfiniteQueryOptions} and {@link useTraceExchangesQuery}. */
interface TraceExchangesQueryOptions {
  /**
   * How many resources to request per page.
   *
   * @defaultValue 50
   */
  readonly pageSize?: number
}

/**
 * Decodes one searchset bundle into a {@link TraceExchangePage}.
 *
 * @param entries - The bundle's entries, whose `resource` may be absent
 * @param links - The bundle's links, read for the continuation cursor
 * @returns The page's exchanges, its unreadable count, and its next cursor
 *
 * @remarks
 * A web-trace resource that fails to decode is counted rather than raised — one
 * resource from an older encoding would otherwise make every recording on the
 * device unreadable. See the package `AGENTS.md` for why the count is reported
 * rather than swallowed.
 */
const decodePage = (
  entries: readonly { readonly resource: DocumentReferenceType | null }[],
  links: readonly PageLink[]
): Effect.Effect<TraceExchangePage> =>
  Effect.gen(function* () {
    const traces = entries.flatMap((entry): readonly DocumentReferenceType[] => {
      const resource = entry.resource
      return resource === null || !isWebTrace(resource) ? [] : [resource]
    })
    const decoded = yield* Effect.forEach(traces, (resource) =>
      Effect.option(fromDocumentReference(resource))
    )
    return {
      exchanges: decoded.flatMap((one) => (Option.isSome(one) ? [one.value] : [])),
      unreadable: decoded.filter(Option.isNone).length,
      nextPageToken: nextPageToken(links),
    }
  })

/**
 * Query options for the paged trace read, for a caller that drives the query
 * itself (a route loader, a test through `QueryClient`).
 *
 * @param runAuthed - The authed runner from router context
 * @param options - Page size
 * @returns Infinite-query options whose pages are {@link TraceExchangePage}s
 *
 * @remarks
 * A bundle with no `next` link has no cursor, so `getNextPageParam` returns
 * `null` — which TanStack Query reads as "no further pages".
 */
const traceExchangesInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  options?: TraceExchangesQueryOptions
): UseInfiniteQueryOptions<
  TraceExchangePage,
  Error,
  InfiniteData<TraceExchangePage, TracePageParam>,
  TraceExchangesQueryKey,
  TracePageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  return infiniteQueryOptions({
    queryKey: [...TRACE_EXCHANGES_QUERY_KEY, { pageSize }] as const,
    initialPageParam: null as TracePageParam,
    getNextPageParam: (lastPage: TraceExchangePage): TracePageParam =>
      lastPage.nextPageToken ?? null,
    queryFn: ({ pageParam }: { readonly pageParam: TracePageParam }): Promise<TraceExchangePage> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.DocumentReference.SearchByGet({
            urlParams: {
              category: WEB_TRACE_CATEGORY_TOKEN,
              _count: pageSize,
              ...(pageParam === null ? {} : { _pageToken: pageParam }),
            },
          })
          return yield* decodePage(bundle.entry, bundle.link)
        })
      ),
  })
}

/**
 * Reads the device's trace recordings, one page at a time. The authed runner
 * comes from router context via `fhir-r4-react`'s `useRunAuthed`.
 *
 * @param options - Page size
 * @returns The infinite query; `data.pages` are {@link TraceExchangePage}s in
 *   the order they were fetched
 *
 * @remarks
 * Deliberately not a suspense query: the sessions list renders what has arrived
 * and keeps fetching, so the caller needs `hasNextPage` / `isFetchingNextPage`
 * rather than a single resolved result.
 */
const useTraceExchangesQuery = (
  options?: TraceExchangesQueryOptions
): UseInfiniteQueryResult<InfiniteData<TraceExchangePage, TracePageParam>, Error> =>
  useInfiniteQuery(traceExchangesInfiniteQueryOptions(useRunAuthed(), options))

export {
  DEFAULT_PAGE_SIZE,
  type TraceExchangePage,
  type TraceExchangesQueryKey,
  type TraceExchangesQueryOptions,
  traceExchangesInfiniteQueryOptions,
  type TracePageParam,
  useTraceExchangesQuery,
  WEB_TRACE_CATEGORY_TOKEN,
}
