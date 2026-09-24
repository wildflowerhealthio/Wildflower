/**
 * The non-standard parameter a first-party client names the owner UI copy it
 * runs from with (its served root), so the pages the server hands back resolve
 * on that copy. See "Client base URL" in the
 * [Jargon Explanation](../../docs/Jargon%20Explanation.md). Held equal to
 * `gatekeeper-rust`'s `domain/client_base_url.rs` by `client-base-url.test.ts`.
 *
 * The server also sends it on a page of the configured owner UI, naming a copy
 * none of the client's registered redirects vouches for, so that page asks the
 * Owner before continuing there.
 */
const CLIENT_BASE_URL_PARAM = 'wildflower_client_base_url'

/**
 * Parse a {@link CLIENT_BASE_URL_PARAM} value the way `gatekeeper-rust` does:
 * an absolute `http`/`https` URL, normalized to a slash-terminated base with no
 * query or fragment. `undefined` for anything else — no server sends one, and
 * a `javascript:` value must never become a link.
 *
 * @example parseClientBaseUrl('https://wildflowerhealthio.github.io/staging/pr-736/app')?.href // 'https://wildflowerhealthio.github.io/staging/pr-736/app/'
 */
const parseClientBaseUrl = (raw: string): URL | undefined => {
  let clientBase: URL
  try {
    clientBase = new URL(raw)
  } catch {
    return undefined
  }
  if (clientBase.protocol !== 'http:' && clientBase.protocol !== 'https:') return undefined
  if (!clientBase.pathname.endsWith('/')) clientBase.pathname = `${clientBase.pathname}/`
  clientBase.search = ''
  clientBase.hash = ''
  return clientBase
}

/**
 * The owner-UI `route` (e.g. `/gatekeeper/devices`) on the copy at
 * `clientBase`, carrying `search` minus {@link CLIENT_BASE_URL_PARAM} — the
 * page a confirmed continuation lands on.
 *
 * @example pageOnClientCopy(new URL('https://example.test/app/'), '/gatekeeper/devices', '?server=s&wildflower_client_base_url=x') // 'https://example.test/app/gatekeeper/devices?server=s'
 */
const pageOnClientCopy = (clientBase: URL, route: string, search: string): string => {
  // `./` keeps the route a path under the copy: bare, a first segment like
  // `a:b` would parse as a scheme and a leading `\\` as another host.
  const page = new URL(`./${route.replace(/^\/+/, '')}`, clientBase)
  const query = new URLSearchParams(search)
  query.delete(CLIENT_BASE_URL_PARAM)
  page.search = query.toString()
  return page.href
}

export { CLIENT_BASE_URL_PARAM, pageOnClientCopy, parseClientBaseUrl }
