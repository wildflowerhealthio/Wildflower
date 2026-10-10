import { Data, Effect, Encoding } from 'effect'

import type { StoredBody } from '../trace-exchange.ts'

/**
 * Ordered `(name, value)` header pairs as received on the wire.
 *
 * @remarks
 * Structurally the sniffer's `HeadersWire` and a collector's
 * `CollectorHttpResponseHeaders`. Restated here as the minimum this module needs, so
 * `web-trace-core` does not have to name a collector type to hash a body.
 */
type CaptureHeaders = readonly (readonly [string, string])[]

/**
 * Raised when `globalThis.crypto.subtle` is missing or its digest refuses.
 *
 * @remarks
 * Every captured body carries a SHA-256, so this is not recoverable by storing
 * less: without a digest there is no honest body record to build. In practice it
 * means an insecure origin (browsers gate `crypto.subtle` on secure contexts) or
 * a runtime below the project's floor, so it is an environment defect rather
 * than a per-response problem.
 */
class BodyDigestUnavailable extends Data.TaggedError('BodyDigestUnavailable')<{
  readonly reason: string
}> {}

/** RFC 9110's default for an entity whose `Content-Type` the server did not state. */
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream'

/**
 * The response's `Content-Type`, lower-cased with its parameters stripped.
 *
 * @param headers - The response headers as received
 * @returns The bare media type, or {@link UNKNOWN_CONTENT_TYPE} when absent or blank
 *
 * @remarks
 * Header names are matched case-insensitively (HTTP does not fix their case,
 * and the sniffer forwards what arrived). Parameters are dropped, so
 * `application/json; charset=utf-8` and `application/json` are one content type
 * — but the *media type* keeps its full `type/subtype+suffix` form, which is
 * what an allowlist matcher needs. The first `Content-Type` wins; a response
 * carrying two is malformed and the record states the one the parser would have
 * used.
 */
const contentTypeOf = (headers: CaptureHeaders): string => {
  const header = headers.find(([name]) => name.toLowerCase() === 'content-type')
  const mediaType = header?.[1].split(';')[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === '' ? UNKNOWN_CONTENT_TYPE : mediaType
}

/**
 * The base64-encoded SHA-256 of `bytes`, matching FHIR's `Attachment.hash`
 * (a `base64Binary`).
 *
 * @param bytes - The raw response body, as a collector's `CollectorHttpResponse.bytes()`
 *   hands it over (its backing store is pinned to a real `ArrayBuffer`, which is
 *   what `crypto.subtle.digest`'s `BufferSource` parameter requires)
 * @returns The digest, base64-encoded
 *
 * @remarks
 * Web Crypto rather than `node:crypto`: a collector runs in a WebView, and this
 * package holds the same line (see the pseudonymizer's `hmac.ts`). Its digest is
 * `Promise`-returning, which is why every capture path is `Effect`-shaped.
 */
const sha256Base64 = (
  bytes: Uint8Array<ArrayBuffer>
): Effect.Effect<string, BodyDigestUnavailable> =>
  Effect.suspend(() =>
    globalThis.crypto?.subtle === undefined
      ? Effect.fail(
          new BodyDigestUnavailable({
            reason:
              'globalThis.crypto.subtle is unavailable (insecure context or unsupported runtime)',
          })
        )
      : Effect.tryPromise({
          try: async () =>
            Encoding.encodeBase64(
              new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
            ),
          catch: (cause) =>
            new BodyDigestUnavailable({ reason: `SHA-256 digest failed: ${String(cause)}` }),
        })
  )

/**
 * Store a body exactly as it arrived — no allowlist, no size cap, no
 * re-encoding.
 *
 * @param bytes - The raw response body
 * @param headers - The response headers, for the content type
 * @returns The stored body, base64 of the raw bytes with its size and digest
 *
 * @remarks
 * This is the **verbatim** capture policy, the counterpart to
 * `web-trace-collector`'s allowlisted one. The difference is not an oversight:
 * an exploratory recording of a whole browsing session needs a cap or it
 * balloons, while a body that justifies a specific clinical resource *is* the
 * provenance — storing its size and hash with no data would defeat the point. If
 * a pathological size ever shows up in practice, raise it then, with real
 * numbers.
 *
 * The base64 is of the raw bytes, never of a UTF-8 decode: a body that is not
 * UTF-8 decodable is stored as it arrived rather than dropped or mangled, so a
 * hash over the stored data means something. Callers must therefore read
 * `CollectorHttpResponse.bytes()`, not `text()`.
 */
const storeBodyVerbatim = (
  bytes: Uint8Array<ArrayBuffer>,
  headers: CaptureHeaders
): Effect.Effect<StoredBody, BodyDigestUnavailable> =>
  Effect.map(sha256Base64(bytes), (hash) => ({
    _tag: 'StoredBody' as const,
    contentType: contentTypeOf(headers),
    data: Encoding.encodeBase64(bytes),
    size: bytes.length,
    hash,
  }))

export {
  BodyDigestUnavailable,
  type CaptureHeaders,
  contentTypeOf,
  sha256Base64,
  storeBodyVerbatim,
  UNKNOWN_CONTENT_TYPE,
}
