/**
 * The `?server=` contract of the static server-docs console.
 *
 * The console is published as a plain static page, so the API it documents is
 * never the origin it is served from: the reader points it at whichever
 * Wildflower server they actually run — the loopback API of a desktop install,
 * or the public origin of a tunnelled one. That target lives in the URL (so a
 * configured console is a shareable link) and is parsed here.
 *
 * Everything in this module is pure string work; the DOM/history wiring that
 * uses it lives in `main.ts`.
 */

import { HOST_LOOPBACK_ORIGIN } from './host-defaults.ts'

/**
 * The query parameter carrying the API origin the request client targets.
 */
const SERVER_QUERY_PARAM = 'server'

/**
 * The target assumed when the URL carries no usable `?server=`: the loopback
 * origin the desktop host's embedded API server binds, read from the shared
 * Tauri config rather than restated here (see `host-defaults.ts`).
 */
const DEFAULT_SERVER_URL = HOST_LOOPBACK_ORIGIN

/**
 * The canonical form of `candidate` as an API origin, or `undefined` when it is
 * not one this console will send requests to.
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
 * The API origin a page load should target, given its `location.search`.
 * Falls back to {@link DEFAULT_SERVER_URL} when the parameter is absent, empty
 * or rejected by {@link normalizeServerUrl}.
 */
const serverUrlFromSearch = (search: string): string => {
  const raw = new URLSearchParams(search).get(SERVER_QUERY_PARAM)
  if (raw === null) return DEFAULT_SERVER_URL
  return normalizeServerUrl(raw) ?? DEFAULT_SERVER_URL
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

export {
  SERVER_QUERY_PARAM,
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  serverUrlFromSearch,
  searchWithServerUrl,
}
