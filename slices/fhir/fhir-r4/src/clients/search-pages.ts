import { Chunk, Data, Effect, HashSet, Option, Stream } from 'effect'

/**
 * Paging a search through the typed client: the matches a searchset `Bundle`
 * carries, the continuation token it carries, and every page of a search read
 * one after another.
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

/** A searchset entry as a reader of matches sees it: what it matched, and how it came to be in the answer. */
interface SearchsetEntry<TResource> {
  readonly resource: TResource | null
  readonly search: { readonly mode: string | null } | null
}

/** The part of a searchset `Bundle` a pager reads: its entries and its links. */
interface SearchsetPage<TResource> {
  readonly entry: readonly SearchsetEntry<TResource>[]
  readonly link: readonly PageLink[]
}

/**
 * A searchset entry that matched the search without carrying the resource it
 * matched: an answer that names a record without giving it, which a reader
 * can neither use nor count out.
 */
class MatchWithoutResource extends Data.TaggedError('MatchWithoutResource')<{
  /** The resource type the search was for. */
  readonly resourceType: string
}> {}

/**
 * A `next` link whose `_pageToken` names a page already read: a server that
 * loops, which paging stops at rather than reading the same page again.
 */
class PageTokenRepeated extends Data.TaggedError('PageTokenRepeated')<{
  readonly pageToken: string
}> {}

/**
 * The resources `page`'s matches carry: every entry but an `outcome` (a
 * server's note about the search), each with its resource. A match without
 * one fails as {@link MatchWithoutResource} rather than going uncounted, so a
 * reader that counts matches and one that lists them read a page alike.
 *
 * @param resourceType - The resource type the search was for, named by the failure
 * @param page - The searchset, or the part of it with its entries
 */
const matchesIn = <TResource>(
  resourceType: string,
  page: { readonly entry: readonly SearchsetEntry<TResource>[] }
): Effect.Effect<readonly TResource[], MatchWithoutResource> =>
  Effect.forEach(
    page.entry.filter((entry) => entry.search?.mode !== 'outcome'),
    ({ resource }) =>
      resource === null
        ? Effect.fail(new MatchWithoutResource({ resourceType }))
        : Effect.succeed(resource)
  )

/** What every page of a search carries once read: its matches, and whether pages were left unread. */
interface SearchPages<TResource> {
  /** The matches of every page read, in page order. */
  readonly matches: readonly TResource[]
  /** Whether the last page read continued to one the page limit left unread. */
  readonly truncated: boolean
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

/** Where the pager is: the token of the page to read (`null` for the first) and the tokens it has read. */
interface PagerPosition {
  readonly pageToken: string | null
  readonly tokensRead: HashSet.HashSet<string>
}

/** One page as the pager read it: its matches, and whether a next page continued it. */
interface PageRead<TResource> {
  readonly matches: readonly TResource[]
  readonly continues: boolean
}

/**
 * Every match a search answers with, page after page: `searchPage` is asked
 * for the first page with no token, then for each page the previous one's
 * `next` link continues, up to `pageLimit` pages. The first page to fail
 * fails the read, as does a match without its resource
 * ({@link matchesIn}) and a `next` link back to a page already read
 * ({@link PageTokenRepeated}).
 *
 * @param resourceType - The resource type the search is for, named by a failure
 * @param searchPage - One page of the search, given the `_pageToken` that
 *   continues it (`None` for the first page)
 * @param options - `pageLimit`: how many pages are read before the list is
 *   given as it is, `truncated`
 * @returns The matches of every page read, in page order, and whether the
 *   page limit left pages unread
 */
const searchAllPages = <TResource, E, R>(
  resourceType: string,
  searchPage: (pageToken: Option.Option<string>) => Effect.Effect<SearchsetPage<TResource>, E, R>,
  options: { readonly pageLimit: number }
): Effect.Effect<SearchPages<TResource>, E | MatchWithoutResource | PageTokenRepeated, R> => {
  const readPage = (
    position: PagerPosition
  ): Effect.Effect<
    readonly [PageRead<TResource>, Option.Option<PagerPosition>],
    E | MatchWithoutResource | PageTokenRepeated,
    R
  > =>
    Effect.gen(function* () {
      const page = yield* searchPage(Option.fromNullable(position.pageToken))
      const matches = yield* matchesIn(resourceType, page)
      const next = nextPageToken(page.link)
      if (next === undefined) return [{ matches, continues: false }, Option.none()] as const
      if (HashSet.has(position.tokensRead, next)) {
        return yield* Effect.fail(new PageTokenRepeated({ pageToken: next }))
      }
      return [
        { matches, continues: true },
        Option.some({ pageToken: next, tokensRead: HashSet.add(position.tokensRead, next) }),
      ] as const
    })
  return Stream.paginateEffect({ pageToken: null, tokensRead: HashSet.empty() }, readPage).pipe(
    Stream.take(options.pageLimit),
    Stream.runCollect,
    Effect.map((pagesRead) => ({
      matches: Chunk.toReadonlyArray(pagesRead).flatMap(({ matches }) => matches),
      truncated:
        Chunk.size(pagesRead) === options.pageLimit &&
        Chunk.last(pagesRead).pipe(Option.exists(({ continues }) => continues)),
    }))
  )
}

export {
  matchesIn,
  MatchWithoutResource,
  NEXT_RELATION,
  nextPageToken,
  PAGE_TOKEN_PARAM,
  PageTokenRepeated,
  searchAllPages,
}
export type { PageLink, SearchPages, SearchsetEntry, SearchsetPage }
