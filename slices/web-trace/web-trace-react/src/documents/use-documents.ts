import { useMemo } from 'react'

import type { DocumentPage, DocumentsQueryOptions, FoundDocument } from '../queries/documents.ts'
import { useDocumentsQuery } from '../queries/documents.ts'

/** What {@link useDocuments} hands the documents browser. */
interface DocumentsState {
  /** Every document across the pages read so far, in server order. */
  readonly documents: readonly FoundDocument[]
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

/**
 * Flattens the pages fetched so far into one list.
 *
 * @param pages - Every page delivered by the infinite query, in fetch order
 * @returns The documents, concatenated
 *
 * @remarks
 * A plain concatenation, unlike the recordings read's `summarizePages`: a
 * document is a resource in its own right, so there is nothing to group and
 * nothing that straddles a page boundary.
 */
const flattenPages = (pages: readonly DocumentPage[]): readonly FoundDocument[] =>
  pages.flatMap((page) => page.documents)

/**
 * Reads the device's `DocumentReference`s under the given filters. The read
 * takes its authed runner from router context.
 *
 * @param options - Filters and page size, forwarded to the underlying read
 * @returns The documents so far, and the paging controls
 *
 * @remarks
 * Changing a filter changes the query key, so paging restarts at the first page
 * of the new search rather than continuing the old one's cursor.
 */
const useDocuments = (options?: DocumentsQueryOptions): DocumentsState => {
  const query = useDocumentsQuery(options)
  const pages = query.data?.pages

  const documents = useMemo(() => flattenPages(pages ?? []), [pages])

  return {
    documents,
    isPending: query.isPending,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: (): void => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage()
    },
    error: query.error,
  }
}

export { type DocumentsState, flattenPages, useDocuments }
