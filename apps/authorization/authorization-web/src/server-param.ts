import {
  arrivingSmartLaunchFrom,
  normalizeServerUrl,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Option } from 'effect'

/**
 * The query parameter naming the server the app manages: its SMART issuer, as
 * a SMART launch names it. Every way in carries it — a server's
 * `management_endpoint`, the launcher's Manage access row — and a pick from
 * the connect menu sets it, so a bookmark of the page signs back in to the same
 * server.
 */
const ISS_PARAM = 'iss'

/**
 * The server `search`'s `?iss=` names, in canonical form, or `undefined` when
 * it names none this page would send requests to. An authorization response's
 * own RFC 9207 `iss` is not a server pick, so a return leg names none.
 */
const serverUrlFromSearch = (search: string): string | undefined =>
  Option.getOrUndefined(
    Option.flatMapNullable(arrivingSmartLaunchFrom(search), ({ iss }) => normalizeServerUrl(iss))
  )

/** `search` with `?iss=` pointed at `serverUrl`, every other parameter kept. */
const searchWithServerUrl = (search: string, serverUrl: string): string => {
  const params = new URLSearchParams(search)
  params.set(ISS_PARAM, serverUrl)
  return `?${params.toString()}`
}

export { ISS_PARAM, searchWithServerUrl, serverUrlFromSearch }
