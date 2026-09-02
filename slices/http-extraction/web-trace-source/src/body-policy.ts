import { Effect, Encoding } from 'effect'
import type { HttpResponse } from 'http-extraction-fundamentals'
import type { TraceBody } from 'web-trace-core'
import { type BodyDigestUnavailable, contentTypeOf, sha256Base64 } from 'web-trace-core/capture'

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
 * `fhir+json`, `fhir`, and `json`. The example table in the body-policy test is
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
  response: HttpResponse.HttpResponse,
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

export { type BodyPolicy, contentTypeTokens, decideBody, isAllowlisted }
