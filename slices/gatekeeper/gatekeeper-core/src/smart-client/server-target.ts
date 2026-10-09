/**
 * The `?server=` contract a static Wildflower page uses to name the API origin
 * it talks to.
 *
 * A page published as a plain static asset is never served from the API it
 * drives: the reader points it at whichever Wildflower server they actually run
 * — the loopback API of a desktop install, or the public origin of a tunnelled
 * one. That target lives in the URL (so a configured page is a shareable link)
 * and is parsed here, as is the `?server=` a SMART launch's `iss` stands for
 * on a page opened with one.
 *
 * Everything here is pure string work; the DOM/history wiring belongs to the
 * app, and so does the fallback target — a console shipped beside a desktop
 * host falls back to that host's loopback origin, which this package has no
 * business knowing. Hence no `DEFAULT_SERVER_URL`: an `undefined` result is
 * where an app substitutes its own.
 */

import { Option } from 'effect'

import { arrivingSmartLaunchFrom } from './arriving-launch.ts'
import { WILDFLOWER_FHIR_PATH } from './smart-discovery.ts'

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

/**
 * The Wildflower server `url` names, in {@link normalizeServerUrl}'s canonical
 * form, whether or not `url` carries the server's `/fhir-r4` mount: a
 * Wildflower server's FHIR base less that mount (its API base, under which
 * sign-in discovery finds the FHIR base again), and any other URL as it is.
 * `url` is a SMART launch's `iss` or a server the reader typed in.
 * `undefined` when `url` is not a URL a page would send requests to.
 */
const serverUrlNamedBy = (url: string): string | undefined => {
  const fhirBaseUrl = normalizeServerUrl(url)
  if (fhirBaseUrl === undefined) return undefined
  return fhirBaseUrl.endsWith(WILDFLOWER_FHIR_PATH)
    ? normalizeServerUrl(fhirBaseUrl.slice(0, -WILDFLOWER_FHIR_PATH.length))
    : fhirBaseUrl
}

/** The query parameters a SMART launch arrives in. */
const SMART_LAUNCH_PARAMS = ['iss', 'launch'] as const

/**
 * The query a page load arriving on `search` settles on. A load opened with a
 * SMART launch ({@link arrivingSmartLaunchFrom}) has `iss` and `launch` taken
 * out, so a reload cannot offer the server a launch it has already spent, and
 * `?server=` set to the server `iss` names ({@link serverUrlNamedBy}),
 * replacing any `?server=` the URL also carried: the launch is what the page
 * was opened to do. An `iss` that names no usable server leaves `?server=` as
 * it was. Any other load's query is `search` itself.
 */
const searchAfterArrivingLaunch = (search: string): string =>
  Option.match(arrivingSmartLaunchFrom(search), {
    onNone: () => search,
    onSome: ({ iss }) => {
      const params = new URLSearchParams(search)
      for (const name of SMART_LAUNCH_PARAMS) params.delete(name)
      const serverUrl = serverUrlNamedBy(iss)
      if (serverUrl !== undefined) params.set(SERVER_QUERY_PARAM, serverUrl)
      const query = params.toString()
      return query === '' ? '' : `?${query}`
    },
  })

export {
  normalizeServerUrl,
  searchAfterArrivingLaunch,
  searchWithServerUrl,
  SERVER_QUERY_PARAM,
  serverUrlNamedBy,
  serverUrlFromSearch,
}
