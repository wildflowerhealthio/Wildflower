import type { DateTime } from 'effect'

/**
 * Ordered `(name, value)` header pairs as received on the wire. HTTP
 * allows the same header name to appear repeatedly (`Set-Cookie` is
 * the canonical case); preserving the array shape keeps the response
 * lossless. Consumers that want lookup by name should use
 * `headersGet(this.headers, 'set-cookie')` (case-insensitive) or
 * fold into a `Map<string, string[]>`.
 */
type Headers = readonly (readonly [string, string])[]

/**
 * One response, as an `EntityDefinition.parse` sees it — the readable surface
 * every entity decodes (or records) from, however the response was obtained.
 *
 * @remarks
 * An interface rather than a class so each acquisition path supplies its own
 * implementation: an archive-driven import builds one with {@link make} from
 * bytes it already holds, while `collector-fundamentals`' live
 * `CollectorHttpResponse` implements it over chunks a sniffer streams in. Everything
 * an entity may know about a response is here — callers never pre-extract a
 * slice of it, so an entity can read `text()`, `headers`, and `url` on demand.
 *
 * `id` and `startedAt` serve a *capturing* entity, one that records the
 * exchange rather than decoding a payload out of it; a decoding entity
 * ignores both. `id` is the source's per-request correlation key, which makes
 * a stored exchange's identity deterministic without threading a counter
 * through `parse`; `startedAt` is the instant the response began, observed by
 * whatever produced it — `parse` runs after the body has settled, so an
 * entity reading its own clock there would label the response's end as its
 * beginning.
 *
 * `bytes()` is the lossless read and `text()` the UTF-8 decode of the same
 * body: a body that is not valid UTF-8 (an image, a protobuf, a gzip)
 * survives `bytes()` but comes back from `text()` peppered with U+FFFD, and a
 * re-encode of that string is not the body that arrived. An entity that
 * stores, hashes, or forwards a body must read `bytes()`; one decoding a
 * known-JSON payload can keep to `text()`. `bytes()` returns a fresh array
 * each call so a caller cannot mutate the underlying body, and its
 * `ArrayBuffer` backing store is pinned because that is what platform
 * `BufferSource` parameters (`crypto.subtle.digest`, `Blob`, `fetch`) accept.
 */
interface HttpResponse {
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly startedAt: DateTime.Utc
  bytes(): Uint8Array<ArrayBuffer>
  text(): string
}

/**
 * The plain data {@link make} builds an {@link HttpResponse} from: the
 * readable fields plus the body, already in hand as one byte array.
 */
interface Init {
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly startedAt: DateTime.Utc
  readonly body: Uint8Array
}

/**
 * Build an {@link HttpResponse} over bytes already in hand.
 *
 * @param source - The response fields and the complete body
 * @returns An `HttpResponse` whose `bytes()` returns a fresh copy of
 *   `source.body` and whose `text()` is its UTF-8 decode
 */
const make = (source: Init): HttpResponse => ({
  id: source.id,
  url: source.url,
  status: source.status,
  statusText: source.statusText,
  headers: source.headers,
  startedAt: source.startedAt,
  bytes: () => {
    const copy = new Uint8Array(source.body.length)
    copy.set(source.body)
    return copy
  },
  text: () => new TextDecoder().decode(source.body),
})

export { make }
export type { Headers, HttpResponse, Init }
