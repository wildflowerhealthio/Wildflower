import { HttpServerRequest } from '@effect/platform'
import { Effect } from 'effect'

import { Origin } from './origin.ts'

const LOOPBACK_REMOTE_ADDRESS_RE = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
// Same shape gate for `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`:
// reject everything that wouldn't compose into a well-formed URL (empty
// strings, whitespace, comma-joined header lists, embedded paths, etc.).
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d+)?$/
const PROTO_RE = /^https?$/

/**
 * The peer is inside the trust boundary when its connection-level remote
 * address is loopback (`127.0.0.0/8`, `::1`, or the IPv4-mapped
 * `::ffff:127.x.x.x`): either a local user or the local tunnel client
 * (which always proxies through `127.0.0.1`). Everything else — direct
 * LAN, public internet, or unknown transport — is untrusted.
 */
const isLoopbackPeer = (remoteAddress: string | undefined): boolean =>
  remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESS_RE.test(remoteAddress)

// Bind hosts that expose *only* the loopback interface, so a LAN/public
// peer can't open a TCP connection in the first place. `localhost`
// resolves to a loopback address; `0.0.0.0`, `::`, and any routable host
// are rejected.
const LOOPBACK_BIND_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i

/**
 * Bind-time guard companion to {@link isLoopbackPeer}: true when binding
 * an HTTP listener to `host` keeps it reachable only over loopback. Use
 * at server startup to refuse a non-loopback bind (`0.0.0.0`, `::`, a
 * LAN address) rather than exposing the server to the network and
 * relying solely on the per-request trust gate.
 */
const isLoopbackBindHost = (host: string): boolean => LOOPBACK_BIND_HOST_RE.test(host)

/**
 * Compute the origin to embed in a handler response from the request
 * headers, falling back to the configured `Origin` when no usable `Host`
 * is present.
 *
 * Callers are assumed to already be inside the trust boundary — the
 * loopback gate lives at the server edge ({@link isLoopbackPeer}, applied
 * by `loopbackGateMiddleware`), so this function only derives *where* the
 * request was targeting, never *who* is allowed to ask.
 *
 * @param headers - Request headers with lowercased keys (the convention
 *   `@effect/platform` normalises to).
 * @param fallback - The configured `Origin` value, returned when no
 *   `Host`/forwarded headers are usable.
 * @returns The origin URL to embed in the response.
 *
 * @remarks
 *  - if `X-Forwarded-{Host,Proto}` are both set AND each parses cleanly
 *    (host as a DNS-shape `[A-Za-z0-9.-]+(:port)?`, proto as
 *    `http`/`https`), they win — the tunnel case;
 *  - otherwise the `Host` header is echoed under `http://`, subject to
 *    the same DNS-shape check (so empty, whitespace, or comma-joined
 *    values fall back). The local server binds plain HTTP by convention,
 *    so the scheme is fixed rather than derived from the request;
 *  - with neither usable, the configured `Origin` fallback is returned.
 */
const requestOriginFromConnection = (
  headers: { readonly [key: string]: string },
  fallback: string
): string => {
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
 * derived from the request headers (see {@link requestOriginFromConnection}
 * for the derivation rules). Use this in handler responses that should
 * echo the caller's URL — e.g. SMART discovery documents — so a client
 * that reaches the server via the tunnel sees tunnel URLs, and one that
 * reaches it via loopback sees loopback URLs.
 *
 * Trust is enforced upstream by `loopbackGateMiddleware`, which rejects
 * any non-loopback peer at the server edge before a handler runs; this
 * effect therefore assumes a trusted caller and cannot fail.
 *
 * Distinct from {@link Origin}, which is the server's canonical served
 * origin (single Subscribable, swapped by tunnel toggles). Use `Origin`
 * for signing/verifying tokens and other places where the value must
 * be stable across callers.
 */
const requestOriginFromHttpRequest: Effect.Effect<
  string,
  never,
  HttpServerRequest.HttpServerRequest | Origin
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const fallback = yield* Origin.get
  return requestOriginFromConnection(request.headers, fallback)
})

export {
  isLoopbackBindHost,
  isLoopbackPeer,
  requestOriginFromConnection,
  requestOriginFromHttpRequest,
}
