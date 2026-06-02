import { HttpServerRequest } from '@effect/platform'
import { Effect, Option } from 'effect'

import { Origin } from './origin.ts'

const LOOPBACK_REMOTE_ADDRESS_RE = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
// Same shape gate for `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`:
// reject everything that wouldn't compose into a well-formed URL (empty
// strings, whitespace, comma-joined header lists, embedded paths, etc.).
const HOST_RE = /^[A-Za-z0-9.\-]+(?::\d+)?$/
const PROTO_RE = /^https?$/

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
 *   - if `X-Forwarded-{Host,Proto}` are both set AND each parses cleanly
 *     (host as a DNS-shape `[A-Za-z0-9.-]+(:port)?`, proto as
 *     `http`/`https`), they win — the tunnel case;
 *   - otherwise the `Host` header is echoed under `http://`, subject to
 *     the same DNS-shape check (so empty, whitespace, or comma-joined
 *     values still fall back). The local server binds plain HTTP by
 *     convention (`apps/wildflower-node/src/index.ts` uses
 *     `node:http.createServer`, and the on-device Expo server is
 *     non-TLS), so the scheme is fixed rather than derived from the
 *     request.
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
  if (
    forwardedHost !== undefined &&
    forwardedProto !== undefined &&
    HOST_RE.test(forwardedHost) &&
    PROTO_RE.test(forwardedProto)
  ) {
    return `${forwardedProto}://${forwardedHost}`
  }
  const host = headers['host']
  if (host !== undefined && HOST_RE.test(host)) return `http://${host}`
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
const requestOriginFromHttpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const fallback = yield* Origin.get
  return requestOriginFromConnection(
    Option.getOrUndefined(request.remoteAddress),
    request.headers,
    fallback
  )
})

export { requestOriginFromConnection, requestOriginFromHttpRequest }
