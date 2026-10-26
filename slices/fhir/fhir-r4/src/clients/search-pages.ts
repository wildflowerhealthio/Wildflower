import { Array, Chunk, Effect, Option, Stream } from 'effect'

/**
 * Paging a search through the typed client: the continuation token a
 * searchset `Bundle` carries, and every page of a search read one after
 * another.
 *
 * @remarks
 * FHIR does not put the next page's cursor in a field of its own: it hands
 * back a whole `link` entry whose `relation` is `next` and whose `url` repeats
 * the search with the cursor added. The typed client takes `_pageToken` as a
 * search parameter, so a pager pulls that one parameter back out of the link
 * rather than following the URL, which would bypass the client's schema and
 * its auth.
 *
 * @packageDocumentation
 */

/** The `Bundle.link.relation` value FHIR gives the continuation link. */
const NEXT_RELATION = 'next'

/** The search parameter the typed client carries a continuation cursor in. */
const PAGE_TOKEN_PARAM = '_pageToken'

/**
 * A `Bundle.link` entry, narrowed to the two fields paging reads.
 *
 * @remarks
 * Structural rather than the whole `BundleLink`: this module only needs the
 * relation and the URL, and stating that keeps the parsing testable without
 * constructing a whole bundle.
 */
interface PageLink {
  readonly relation: string
  readonly url: string
}

/** The part of a searchset `Bundle` a pager reads: its entries' resources and its links. */
interface SearchsetPage<TResource> {
  readonly entry: readonly { readonly resource: TResource | null }[]
  readonly link: readonly PageLink[]
}

/**
 * Any base, used only so a server-relative `next` URL parses.
 *
 * @remarks
 * `new URL` rejects a relative reference without one, and a server is free to
 * return either form. The origin is never read, only the query string, so the
 * value is arbitrary and deliberately not a real host.
 */
const RELATIVE_LINK_BASE = 'https://relative.invalid'

/**
 * The `_pageToken` that continues a searchset, or `undefined` at the last page.
 *
 * @param links - The bundle's `link` entries, in the order the server sent them
 * @returns The cursor to pass as the next request's `_pageToken`, or `undefined`
 *   when there is no next link, its URL is unparseable, or it carries no token
 *
 * @remarks
 * An unparseable or token-less `next` link reads as "no more pages" rather than
 * raising: the caller cannot act on the distinction, since either way there is
 * no cursor to send. A present-but-empty `_pageToken=` is token-less too: the
 * server minted no cursor, and treating `''` as one would make paging ask for
 * the same page forever, since the empty string is not `null` and so reads to
 * TanStack Query as a real next page.
 */
const nextPageToken = (links: readonly PageLink[]): string | undefined => {
  const next = links.find((link) => link.relation === NEXT_RELATION)
  if (next === undefined) return undefined
  try {
    const token = new URL(next.url, RELATIVE_LINK_BASE).searchParams.get(PAGE_TOKEN_PARAM)
    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/**
 * Every resource a search answers with, page after page: `searchPage` is asked
 * for the first page with no token, then for each page the previous one's
 * `next` link continues, up to `pageLimit` pages. The first page to fail
 * fails the read.
 *
 * @param searchPage - One page of the search, given the `_pageToken` that
 *   continues it (`None` for the first page)
 * @param options - `pageLimit`: how many pages are read before the list is
 *   given as it is
 * @returns The resources of every page read, in page order
 */
const searchAllPages = <TResource, E, R>(
  searchPage: (pageToken: Option.Option<string>) => Effect.Effect<SearchsetPage<TResource>, E, R>,
  options: { readonly pageLimit: number }
): Effect.Effect<readonly TResource[], E, R> =>
  // The pager's state is the token of the page to read, null for the first.
  Stream.paginateEffect(
    null,
    (
      pageToken: string | null
    ): Effect.Effect<readonly [readonly TResource[], Option.Option<string | null>], E, R> =>
      Effect.map(searchPage(Option.fromNullable(pageToken)), (page) => [
        Array.filterMap(page.entry, ({ resource }) => Option.fromNullable(resource)),
        Option.fromNullable(nextPageToken(page.link)),
      ])
  ).pipe(
    Stream.take(options.pageLimit),
    Stream.runCollect,
    Effect.map((pages) => Chunk.toReadonlyArray(pages).flat())
  )

export { NEXT_RELATION, nextPageToken, PAGE_TOKEN_PARAM, searchAllPages }
export type { PageLink, SearchsetPage }
