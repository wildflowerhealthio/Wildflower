/**
 * What a paged read hands its caller: the pages landed so far, and whether and
 * how the next one is coming.
 *
 * @typeParam TPage - One page of the read.
 *
 * @remarks
 * Structural, and a subset of TanStack Query's `useInfiniteQuery` result, so a
 * `useInfiniteQuery(…)` return value is one as it stands. Nothing here imports
 * TanStack: any paged read with this shape can be drained by
 * {@link useFetchEveryPage} and described by {@link pagedQueryStatusOf}.
 */
interface PagedQuery<TPage> {
  /** Every page landed so far, in fetch order; `undefined` before the first. */
  readonly data: { readonly pages: readonly TPage[] } | undefined
  /** The read's latest failure, first page or later. */
  readonly error: unknown
  /** Whether the read has failed — with no pages, the first page failed. */
  readonly isError: boolean
  /** Whether the server reported a page after the last one landed. */
  readonly hasNextPage: boolean
  /** Whether that next page is in flight. */
  readonly isFetchingNextPage: boolean
  /** Whether the last attempt at a next page failed; the pages before it are kept. */
  readonly isFetchNextPageError: boolean
  /** Request the next page. */
  readonly fetchNextPage: () => Promise<unknown>
}

/**
 * Where a paged read stands, as one value a page can render from:
 *
 * - `loading`: no page has landed and none has failed — the first is in flight
 *   (or not yet asked for).
 * - `failed`: the first page failed, so there is nothing to show but `error`.
 * - `paging`: pages have landed and the server has more; `isFetchingNextPage`
 *   says whether the next one is in flight right now.
 * - `page-failed`: a later page failed; the pages before it are kept, and
 *   nothing more arrives until the read asks again.
 * - `complete`: the last page has landed.
 */
type PagedQueryStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'paging'; readonly isFetchingNextPage: boolean }
  | { readonly kind: 'page-failed'; readonly error: unknown }
  | { readonly kind: 'complete' }

/**
 * Describe where `pagedQuery` stands as a {@link PagedQueryStatus}.
 *
 * @param pagedQuery - The paged read, e.g. a `useInfiniteQuery` result.
 * @returns Its status: a first-page failure over loading, a later-page failure
 *   over paging, and `complete` only once no next page is reported.
 */
const pagedQueryStatusOf = <TPage>(pagedQuery: PagedQuery<TPage>): PagedQueryStatus => {
  if (pagedQuery.data === undefined) {
    return pagedQuery.isError ? { kind: 'failed', error: pagedQuery.error } : { kind: 'loading' }
  }
  if (pagedQuery.isFetchNextPageError) return { kind: 'page-failed', error: pagedQuery.error }
  if (pagedQuery.hasNextPage) {
    return { kind: 'paging', isFetchingNextPage: pagedQuery.isFetchingNextPage }
  }
  return { kind: 'complete' }
}

export { pagedQueryStatusOf, type PagedQuery, type PagedQueryStatus }
