import { HttpServerRequest } from '@effect/platform'
import { Effect } from 'effect'

import { Origin } from './origin.ts'

const LOOPBACK_HOST_RE = /^127\.0\.0\.1(?::\d+)?$/

/**
 * Compute the origin for the inbound request from its headers, with a
 * fallback for cases we don't trust.
 *
 * Trust model:
 *  - The `Host` header is only trusted when it is the loopback address
 *    `127.0.0.1[:port]`. Anything else (LAN IP, public hostname someone
 *    set by hand) falls back to the configured `Origin`.
 *  - `X-Forwarded-Host` / `X-Forwarded-Proto` are trusted only when the
 *    underlying `Host` is loopback — i.e. the request was forwarded by
 *    the local tunnel client, which always proxies to `127.0.0.1`. A
 *    public attacker can't reach our server with `Host: 127.0.0.1`
 *    unless they're already inside our trust boundary.
 */
const requestOriginFromHeaders = (
  headers: { readonly [key: string]: string },
  fallback: string
): string => {
  const host = headers['host']
  if (host === undefined || !LOOPBACK_HOST_RE.test(host)) return fallback
  const forwardedHost = headers['x-forwarded-host']
  const forwardedProto = headers['x-forwarded-proto']
  if (forwardedHost !== undefined && forwardedProto !== undefined) {
    return `${forwardedProto}://${forwardedHost}`
  }
  return `http://${host}`
}

/**
 * Request-scoped origin: the URL the inbound request was targeting,
 * derived from `Host` / forwarding headers (see {@link requestOriginFromHeaders}
 * for the trust rules). Use this in handler responses that should echo
 * the caller's URL — e.g. SMART discovery documents — so a client that
 * reaches the server via the tunnel sees tunnel URLs, and one that
 * reaches it via loopback sees loopback URLs.
 *
 * Distinct from {@link Origin}, which is the *server's* canonical
 * served origin (single Subscribable, swapped by tunnel toggles). Use
 * `Origin` for signing/verifying tokens and other places where the
 * value must be stable across callers.
 */
const requestOriginFromRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const fallback = yield* Origin.get
  return requestOriginFromHeaders(request.headers, fallback)
})

export { requestOriginFromHeaders, requestOriginFromRequest }
