import { HttpServerRequest } from '@effect/platform'
import { Effect, Option } from 'effect'

import { Origin } from './origin.ts'

const LOOPBACK_REMOTE_ADDRESS_RE = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/

/**
 * Compute the origin to embed in a handler response from the inbound
 * connection's remote address and request headers, falling back to the
 * configured `Origin` when we don't trust the caller.
 *
 * @param remoteAddress - The peer's connection-level address as reported
 *   by the platform (`socket.remoteAddress` on Node, the native
 *   payload's `ip` on Expo). `undefined` when transport info is
 *   unavailable — treated as untrusted.
 * @param headers - Request headers with lowercased keys (the convention
 *   `@effect/platform` normalises to).
 * @param fallback - The configured `Origin` value, returned when the
 *   request can't be trusted.
 * @returns The origin URL to embed in the response.
 *
 * @remarks
 *  Trust gate is the connection's remote address, not the `Host`
 *  header. `Host` is set by the client and a public attacker against an
 *  `HOSTNAME=0.0.0.0`-bound server could forge `Host: 127.0.0.1`;
 *  `remoteAddress` is set by the kernel from the TCP peer and is
 *  unforgeable by a remote caller.
 *
 *  When the peer is loopback (`127.0.0.0/8`, `::1`, or the IPv4-mapped
 *  `::ffff:127.x.x.x`) the request was either a local user or the local
 *  tunnel client (which always proxies through `127.0.0.1`); both are
 *  inside the trust boundary, so:
 *   - if `X-Forwarded-{Host,Proto}` are both set, they win (the tunnel
 *     case);
 *   - otherwise the `Host` header is echoed verbatim with an `http://`
 *     scheme (the local-user case).
 *
 *  When the peer is non-loopback or unknown, the configured `Origin`
 *  is returned unchanged.
 */
const requestOriginFromConnection = (
  remoteAddress: string | undefined,
  headers: { readonly [key: string]: string },
  fallback: string
): string => {
  if (remoteAddress === undefined || !LOOPBACK_REMOTE_ADDRESS_RE.test(remoteAddress)) {
    return fallback
  }
  const forwardedHost = headers['x-forwarded-host']
  const forwardedProto = headers['x-forwarded-proto']
  if (forwardedHost !== undefined && forwardedProto !== undefined) {
    return `${forwardedProto}://${forwardedHost}`
  }
  const host = headers['host']
  if (host !== undefined) return `http://${host}`
  return fallback
}

/**
 * Request-scoped origin: the URL the inbound request was targeting,
 * derived from the connection's remote address and request headers
 * (see {@link requestOriginFromConnection} for the trust rules). Use
 * this in handler responses that should echo the caller's URL — e.g.
 * SMART discovery documents — so a client that reaches the server via
 * the tunnel sees tunnel URLs, and one that reaches it via loopback
 * sees loopback URLs.
 *
 * Distinct from {@link Origin}, which is the server's canonical served
 * origin (single Subscribable, swapped by tunnel toggles). Use `Origin`
 * for signing/verifying tokens and other places where the value must
 * be stable across callers.
 */
const requestOriginFromRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const fallback = yield* Origin.get
  return requestOriginFromConnection(
    Option.getOrUndefined(request.remoteAddress),
    request.headers,
    fallback
  )
})

export { requestOriginFromConnection, requestOriginFromRequest }
