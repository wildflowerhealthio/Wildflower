import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'
import { Effect } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import { useRunAuthed } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { DocumentReference } from 'fhir-r4/resources'

import {
  documentSearchParams,
  NO_DOCUMENT_FILTERS,
  type DocumentFilters,
} from '../documents/document-filters.ts'
import { DOCUMENTS_QUERY_KEY } from './keys.ts'
import { nextPageToken } from './page-token.ts'

/**
 * The paged read behind the documents browser: `DocumentReference`s of **any**
 * category, as the server returned them.
 *
 * @remarks
 * The sibling of `trace-exchanges.ts`, and deliberately not a parameter on it.
 * That read is pinned to the web-trace category and hands back decoded
 * `TraceExchange`s; this one is category-agnostic and hands back the FHIR
 * resources themselves. A single read that sometimes decoded and sometimes did
 * not would have no one return type, so the two stay apart and share only the
 * cursor helper.
 *
 * @packageDocumentation
 */

/**
 * A `DocumentReference` as it arrives from a search.
 *
 * @remarks
 * The searchset's resources carry a mandatory `id` — the server assigned one
 * before it could return the row — which is what lets a row be selected and a
 * detail be addressed. The resource schema's own `id` is nullable because an
 * unsaved resource has none.
 */
type FoundDocument = Omit<typeof DocumentReference.Schema.Type, 'id'> & { readonly id: string }

/**
 * How many `DocumentReference`s one page requests.
 *
 * @remarks
 * Smaller than the recordings page size: a clinical document's inline
 * `Attachment.data` can be far larger than a trace body, and the browser is a
 * list the reader scans rather than a corpus something groups across.
 */
const DEFAULT_DOCUMENTS_PAGE_SIZE = 25

/** One page of documents, plus the cursor for the next. */
interface DocumentPage {
  /** Every document on the page, in the order the server sent them. */
  readonly documents: readonly FoundDocument[]
  /** The cursor for the following page, or `undefined` at the end of the searchset. */
  readonly nextPageToken: string | undefined
}

/** The cursor type paging carries; `null` is the first page, not a page named null. */
type DocumentPageParam = string | null

/** Query key for the paged read, distinguished by page size and active filters. */
type DocumentsQueryKey = readonly [
  ...typeof DOCUMENTS_QUERY_KEY,
  { readonly pageSize: number; readonly filters: DocumentFilters },
]

/** Options for {@link documentsInfiniteQueryOptions} and {@link useDocumentsQuery}. */
interface DocumentsQueryOptions {
  /**
   * The active filters, sent as search parameters.
   *
   * @defaultValue every axis neutral, i.e. every document on the device
   */
  readonly filters?: DocumentFilters
  /**
   * How many resources to request per page.
   *
   * @defaultValue 25
   */
  readonly pageSize?: number
}

/**
 * Query options for the paged documents read, for a caller that drives the
 * query itself (a route loader, a test through `QueryClient`).
 *
 * @param runAuthed - The authed runner from router context
 * @param options - Filters and page size
 * @returns Infinite-query options whose pages are {@link DocumentPage}s
 *
 * @remarks
 * An entry with no `resource` is dropped rather than counted. Unlike the trace
 * read there is no second, per-resource decode to fail leniently — the typed
 * client decodes the whole bundle, so a `DocumentReference` the schema rejects
 * fails the page. That is the client's contract, not a choice made here; see
 * the package `AGENTS.md`.
 */
const documentsInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  options?: DocumentsQueryOptions
): UseInfiniteQueryOptions<
  DocumentPage,
  Error,
  InfiniteData<DocumentPage, DocumentPageParam>,
  DocumentsQueryKey,
  DocumentPageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_DOCUMENTS_PAGE_SIZE
  const filters = options?.filters ?? NO_DOCUMENT_FILTERS
  return infiniteQueryOptions({
    queryKey: [...DOCUMENTS_QUERY_KEY, { pageSize, filters }] as const,
    initialPageParam: null as DocumentPageParam,
    getNextPageParam: (lastPage: DocumentPage): DocumentPageParam => lastPage.nextPageToken ?? null,
    queryFn: ({ pageParam }: { readonly pageParam: DocumentPageParam }): Promise<DocumentPage> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.DocumentReference.SearchByGet({
            urlParams: {
              ...documentSearchParams(filters),
              _count: pageSize,
              ...(pageParam === null ? {} : { _pageToken: pageParam }),
            },
          })
          return {
            documents: bundle.entry.flatMap((entry): readonly FoundDocument[] =>
              entry.resource === null ? [] : [entry.resource]
            ),
            nextPageToken: nextPageToken(bundle.link),
          }
        })
      ),
  })
}

/**
 * Reads the device's `DocumentReference`s, one page at a time. The authed
 * runner comes from router context via `fhir-r4-react`'s `useRunAuthed`.
 *
 * @param options - Filters and page size
 * @returns The infinite query; `data.pages` are {@link DocumentPage}s in the
 *   order they were fetched
 *
 * @remarks
 * Deliberately not a suspense query, for the same reason the recordings read is
 * not: the list renders what has arrived and offers to fetch more.
 */
const useDocumentsQuery = (
  options?: DocumentsQueryOptions
): UseInfiniteQueryResult<InfiniteData<DocumentPage, DocumentPageParam>, Error> =>
  useInfiniteQuery(documentsInfiniteQueryOptions(useRunAuthed(), options))

export {
  DEFAULT_DOCUMENTS_PAGE_SIZE,
  type DocumentPage,
  type DocumentPageParam,
  type DocumentsQueryKey,
  type DocumentsQueryOptions,
  documentsInfiniteQueryOptions,
  type FoundDocument,
  useDocumentsQuery,
}
