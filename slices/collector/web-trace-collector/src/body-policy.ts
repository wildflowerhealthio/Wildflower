import type { Response } from 'collector-fundamentals/model'
import { Data, Effect, Encoding } from 'effect'
import type { TraceBody } from 'web-trace-core'

/**
 * The capture-time body policy: whether a sniffed response's body is stored in
 * full or recorded as a deliberate omission.
 *
 * @remarks
 * This is the **allowlisted** body policy of the two `web-trace-core`'s codec
 * expresses (the other, verbatim capture for provenance, belongs to a different
 * consumer). It governs **bodies only**. Nothing here decides whether an
 * exchange is recorded — every exchange the sniffer reports becomes a
 * `DocumentReference`, and a body this module declines still contributes its
 * `size` and `hash`, so a trace says what it dropped rather than being silently
 * lossy.
 *
 * @packageDocumentation
 */

/**
 * Raised when `globalThis.crypto.subtle` is missing or its digest refuses.
 *
 * @remarks
 * Every body — stored or skipped — carries a SHA-256, so this is not
 * recoverable by storing less: without a digest there is no honest
 * `TraceExchange` to build. In practice it means an insecure origin (browsers
 * gate `crypto.subtle` on secure contexts) or a runtime below the project's
 * floor, so it is an environment defect rather than a per-response problem.
 * The entity turns it into a `ParseError` for the one exchange that hit it,
 * which the run records as a failed sniff and carries on from.
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
 * what {@link contentTypeTokens} needs. The first `Content-Type` wins; a
 * response carrying two is malformed and the trace records the one the parser
 * would have used.
 */
const contentTypeOf = (headers: Response.RemoteResponseHeaders): string => {
  const header = headers.find(([name]) => name.toLowerCase() === 'content-type')
  const mediaType = header?.[1].split(';')[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === '' ? UNKNOWN_CONTENT_TYPE : mediaType
}

/**
 * The allowlist tokens a media type answers to.
 *
 * @param contentType - A bare media type from {@link contentTypeOf}
 * @returns Every token an allowlist entry could name this content type by
 *
 * @remarks
 * A literal full-string match would be useless in practice: the single most
 * interesting body in a health portal trace is `application/fhir+json`, which no
 * one thinks to add to a list they were told defaults to "json". So a media type
 * answers to its top-level type, its subtype, and — when the subtype carries a
 * structured suffix (RFC 6839's `+json`, `+xml`, …) — both halves of that
 * subtype, making `application/fhir+json` answer to all of `application`,
 * `fhir+json`, `fhir`, and `json`. The example table in `body-policy.test.ts` is
 * the readable statement of the rule; extend it when you touch this.
 *
 * The top-level type being a token is what makes the default `text` entry mean
 * "any `text/*`", including `text/javascript`. That is deliberate — they are
 * text, and a trace of an SPA is more legible with them — and `maxBodyBytes` is
 * what keeps a bundle from dominating the recording.
 */
const contentTypeTokens = (contentType: string): ReadonlySet<string> => {
  const [type, subtype] = contentType.split('/')
  const tokens = new Set<string>()
  if (type !== undefined && type !== '') tokens.add(type)
  if (subtype === undefined || subtype === '') return tokens
  tokens.add(subtype)
  const plus = subtype.lastIndexOf('+')
  if (plus > 0) {
    tokens.add(subtype.slice(0, plus))
    tokens.add(subtype.slice(plus + 1))
  }
  return tokens
}

/**
 * Whether a content type is in the configured allowlist.
 *
 * @param contentType - A bare media type from {@link contentTypeOf}
 * @param allowlist - The configured `bodyContentTypes`
 * @returns `true` when any of the type's {@link contentTypeTokens} is listed
 */
const isAllowlisted = (contentType: string, allowlist: readonly string[]): boolean => {
  const tokens = contentTypeTokens(contentType)
  return allowlist.some((entry) => tokens.has(entry.trim().toLowerCase()))
}

/**
 * The base64-encoded SHA-256 of `bytes`, matching FHIR's `Attachment.hash`
 * (a `base64Binary`).
 *
 * @param bytes - The raw response body, as `RemoteResponse.bytes()` hands it
 *   over (its backing store is pinned to a real `ArrayBuffer`, which is what
 *   `crypto.subtle.digest`'s `BufferSource` parameter requires)
 * @returns The digest, base64-encoded
 *
 * @remarks
 * Web Crypto rather than `node:crypto`: a collector runs in a WebView, and the
 * `-core` package this feeds holds the same line. Its digest is
 * `Promise`-returning, which is why the whole body policy is `Effect`-shaped.
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

/** The two knobs {@link decideBody} reads off the collector's config. */
interface BodyPolicy {
  readonly bodyContentTypes: readonly string[]
  readonly maxBodyBytes: number
}

/**
 * Decide whether a sniffed response's body is stored or recorded as skipped.
 *
 * @param response - The settled response, read through `bytes()` so a non-UTF-8
 *   body survives
 * @param policy - The configured allowlist and size cap
 * @returns A `StoredBody` carrying the base64 body, or a `SkippedBody` carrying
 *   the same `size` and `hash` plus the reason it was declined
 *
 * @remarks
 * `size` and `hash` are computed over the raw bytes either way, so a skipped
 * body is still evidence: the trace states how big it was and what it hashed
 * to. Content type is checked before size, so a body that is both un-allowlisted
 * and over the cap reports the allowlist as its reason — the one the user
 * changes to get it back.
 */
const decideBody = (
  response: Response.RemoteResponse,
  policy: BodyPolicy
): Effect.Effect<TraceBody, BodyDigestUnavailable> =>
  Effect.gen(function* () {
    const bytes = response.bytes()
    const contentType = contentTypeOf(response.headers)
    const size = bytes.length
    const hash = yield* sha256Base64(bytes)

    if (!isAllowlisted(contentType, policy.bodyContentTypes)) {
      return {
        _tag: 'SkippedBody',
        contentType,
        size,
        hash,
        reason: `content type ${contentType} is not in the configured allowlist (${policy.bodyContentTypes.join(', ')})`,
      } as const
    }
    if (size > policy.maxBodyBytes) {
      return {
        _tag: 'SkippedBody',
        contentType,
        size,
        hash,
        reason: `body of ${size} bytes exceeds the configured maxBodyBytes of ${policy.maxBodyBytes}`,
      } as const
    }
    return {
      _tag: 'StoredBody',
      contentType,
      // Base64 of the raw bytes, never of `text()`: a body that is not UTF-8
      // decodable is stored as it arrived rather than dropped or mangled.
      data: Encoding.encodeBase64(bytes),
      size,
      hash,
    } as const
  })

export {
  BodyDigestUnavailable,
  type BodyPolicy,
  contentTypeOf,
  contentTypeTokens,
  decideBody,
  isAllowlisted,
  sha256Base64,
  UNKNOWN_CONTENT_TYPE,
}
