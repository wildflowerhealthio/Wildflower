/**
 * Reading the server's continuation token out of a searchset `Bundle`.
 *
 * @remarks
 * FHIR does not put the next page's cursor in a field of its own: it hands back
 * a whole `link` entry whose `relation` is `next` and whose `url` repeats the
 * search with the cursor added. The typed client takes `_pageToken` as a search
 * parameter, so the viewer's job is to pull that one parameter back out of the
 * link rather than to follow the URL — following it would bypass the client's
 * schema and its auth.
 */

/** The `Bundle.link.relation` value FHIR gives the continuation link. */
const NEXT_RELATION = 'next'

/** The search parameter the typed client carries a continuation cursor in. */
const PAGE_TOKEN_PARAM = '_pageToken'

/**
 * A `Bundle.link` entry, narrowed to the two fields paging reads.
 *
 * @remarks
 * Structural rather than an import of the FHIR `BundleLink` type: this module
 * only needs the relation and the URL, and stating that keeps the parsing
 * testable without constructing a whole bundle.
 */
interface PageLink {
  readonly relation: string
  readonly url: string
}

/**
 * Any base, used only so a server-relative `next` URL parses.
 *
 * @remarks
 * `new URL` rejects a relative reference without one, and HFS is free to return
 * either form. The origin is never read — only the query string is — so the
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
 * no cursor to send. A present-but-empty `_pageToken=` is token-less too — the
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

export { NEXT_RELATION, nextPageToken, PAGE_TOKEN_PARAM, type PageLink }
