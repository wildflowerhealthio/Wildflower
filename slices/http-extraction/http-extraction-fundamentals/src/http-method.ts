import { Schema } from 'effect'

/**
 * The closed set of HTTP request verbs a {@link UrlMatch.make} matcher can
 * require. Deliberately omits `'UNKNOWN'`: a matcher declares what verb its
 * URL is served under, which is a positive fact — an absent method is a
 * different fact carried as {@link HarMethodValue}'s `'UNKNOWN'`, and
 * downstream as `Option.none()`.
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * The wire value carried by a HAR entry's `request.method`: the seven real
 * verbs plus `'UNKNOWN'`, mirroring HAR's own
 * `optionalWith(String, default: 'UNKNOWN')` for a request whose method the
 * archive dropped. Foreign archives that carry an unrecognized verb are
 * normalized to `'UNKNOWN'` at the projection boundary rather than failing the
 * file.
 */
type HarMethodValue = HttpMethod | 'UNKNOWN'

const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]

/** Schema for {@link HttpMethod}. */
const HttpMethodSchema = Schema.Literal(...HTTP_METHODS).annotations({
  identifier: 'HttpMethod',
  description: 'One of the seven real HTTP request verbs (never UNKNOWN).',
})

/** Schema for {@link HarMethodValue} — the seven verbs plus `'UNKNOWN'`. */
const HarMethodValueSchema = Schema.Literal(...HTTP_METHODS, 'UNKNOWN').annotations({
  identifier: 'HarMethodValue',
  description: "A HAR entry's request method: an HTTP verb, or 'UNKNOWN'.",
})

/** True iff `value` is one of the seven real HTTP verbs. */
const isHttpMethod = (value: string): value is HttpMethod =>
  (HTTP_METHODS as readonly string[]).includes(value)

export { HarMethodValueSchema, HttpMethodSchema, HTTP_METHODS, isHttpMethod }
export type { HarMethodValue, HttpMethod }
