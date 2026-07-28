/**
 * The viewer's reads: paged trace `DocumentReference`s, decoded back into
 * {@link TraceExchange}s by `web-trace-core`'s codec.
 *
 * @packageDocumentation
 */
export {
  DEFAULT_DOCUMENTS_PAGE_SIZE,
  type DocumentPage,
  type DocumentPageParam,
  type DocumentsQueryKey,
  type DocumentsQueryOptions,
  documentsInfiniteQueryOptions,
  type FoundDocument,
  useDocumentsQuery,
} from './documents.ts'
export { DOCUMENTS_QUERY_KEY, TRACE_EXCHANGES_QUERY_KEY, WEB_TRACE_QUERY_KEY } from './keys.ts'
export { NEXT_RELATION, nextPageToken, PAGE_TOKEN_PARAM, type PageLink } from './page-token.ts'
export {
  DEFAULT_PAGE_SIZE,
  type TraceExchangePage,
  type TraceExchangesQueryKey,
  type TraceExchangesQueryOptions,
  traceExchangesInfiniteQueryOptions,
  type TracePageParam,
  useTraceExchangesQuery,
  WEB_TRACE_CATEGORY_TOKEN,
} from './trace-exchanges.ts'
