/**
 * The `?server=` contract a static Wildflower page uses to name the API origin
 * it talks to.
 *
 * A page published as a plain static asset is never served from the API it
 * drives: the reader points it at whichever Wildflower server they actually run
 * — the loopback API of a desktop install, or the public origin of a tunnelled
 * one. That target lives in the URL (so a configured page is a shareable link)
 * and is parsed here.
 *
 * Everything here is pure string work; the DOM/history wiring belongs to the
 * app, and so does the fallback target — a console shipped beside a desktop
 * host falls back to that host's loopback origin, which this package has no
 * business knowing. Hence no `DEFAULT_SERVER_URL`: an `undefined` result is
 * where an app substitutes its own.
 */

/**
 * The query parameter carrying the API origin the request client targets.
 */
const SERVER_QUERY_PARAM = 'server'

/**
 * The canonical form of `candidate` as an API origin, or `undefined` when it is
 * not one a page will send requests to.
 *
 * Accepted: an absolute `http:` / `https:` URL with a host. Everything else is
 * rejected — notably `javascript:` and `data:` (which would turn a shared link
 * into a script-injection vector), protocol-relative `//host` and bare hosts
 * (no scheme means no absolute parse), and any other scheme (`file:`, `ftp:`,
 * custom app schemes) the request client could not use anyway.
 *
 * Canonicalising drops the query, the fragment and any userinfo, and strips a
 * trailing slash from the path, so the result concatenates cleanly with the
 * leading-slash paths in an OpenAPI document.
 */
const normalizeServerUrl = (candidate: string): string | undefined => {
  let url: URL
  try {
    // No base argument: a relative or protocol-relative input has nothing to
    // resolve against and throws, which is exactly the rejection we want.
    url = new URL(candidate.trim())
  } catch {
    return undefined
  }

  // A hostless `http://` never gets this far — the URL parser rejects it for
  // these schemes — so a surviving `http:`/`https:` URL always has a host.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * The API origin `search` names, or `undefined` when it names none this page
 * would accept — the parameter absent, empty, or rejected by
 * {@link normalizeServerUrl}. The caller substitutes its own default.
 */
const serverUrlFromSearch = (search: string): string | undefined => {
  const raw = new URLSearchParams(search).get(SERVER_QUERY_PARAM)
  if (raw === null) return undefined
  return normalizeServerUrl(raw)
}

/**
 * `search` with `?server=` set to the canonical form of `serverUrl`, leaving
 * every other parameter untouched. An unusable `serverUrl` drops the parameter
 * instead of writing a value the next load would ignore. The result includes
 * the leading `?` unless it is empty.
 */
const searchWithServerUrl = (search: string, serverUrl: string): string => {
  const params = new URLSearchParams(search)
  const normalized = normalizeServerUrl(serverUrl)
  if (normalized === undefined) {
    params.delete(SERVER_QUERY_PARAM)
  } else {
    params.set(SERVER_QUERY_PARAM, normalized)
  }
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export { normalizeServerUrl, searchWithServerUrl, SERVER_QUERY_PARAM, serverUrlFromSearch }
