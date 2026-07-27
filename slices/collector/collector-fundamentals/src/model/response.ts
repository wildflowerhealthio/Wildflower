import type { SnifferRequestId } from 'browser-sniffer-core'
import type { DateTime } from 'effect'

/**
 * Ordered `(name, value)` header pairs as received on the wire. HTTP
 * allows the same header name to appear repeatedly (`Set-Cookie` is
 * the canonical case); preserving the array shape keeps the response
 * lossless. Consumers that want lookup by name should use
 * `headersGet(this.headers, 'set-cookie')` (case-insensitive) or
 * fold into a `Map<string, string[]>`.
 */
type RemoteResponseHeaders = readonly (readonly [string, string])[]

/**
 * One in-flight (then settled) sniffed response, as an `EntityDefinition.parse`
 * sees it.
 *
 * @remarks
 * The constructor mirrors the sniffer's `ResponseStart` wire body field-for-field
 * (`id`, `url`, `status`, `statusText`, `headers`) and adds `startedAt`, the
 * instant the tracker observed that event. Everything an entity is allowed to
 * know about a response is here: the tracker never pre-extracts a slice of it,
 * so an entity can reach for `text()`, `bytes()`, `headers`, or `url` on demand
 * without the dispatcher having to guess in advance which it will need.
 *
 * `id` and `startedAt` exist for a capturing entity that records the exchange
 * itself rather than decoding a payload out of it (`web-trace-collector`): the
 * id is the sniffer's own per-request correlation key, which makes a recorded
 * exchange's storage id deterministic without threading a counter through
 * `parse`, and `startedAt` is the only instant on the response the sniffer
 * actually observes. A decoding entity is free to ignore both.
 */
class RemoteResponse {
  #chunks: Uint8Array[] = []

  constructor(
    public readonly id: typeof SnifferRequestId.Type,
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly headers: RemoteResponseHeaders,
    public readonly startedAt: DateTime.Utc
  ) {}

  appendChunk(chunk: Uint8Array): void {
    this.#chunks.push(chunk)
  }

  /** Total decoded body size in bytes across all buffered chunks. */
  get byteLength(): number {
    return this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  }

  /** Number of buffered chunks received over the wire. */
  get chunkCount(): number {
    return this.#chunks.length
  }

  /**
   * The raw body, as the bytes that arrived.
   *
   * @returns A fresh `Uint8Array` of every buffered chunk concatenated in order
   *
   * @remarks
   * The lossless counterpart to {@link text}: a body that is not valid UTF-8
   * (an image, a protobuf, a gzip the shim did not decode) survives here but
   * comes back from `text()` peppered with U+FFFD replacement characters, and
   * a re-encode of that string is not the body that arrived. An entity that
   * stores, hashes, or forwards a body must read it through this; one that
   * decodes a known-JSON payload can keep using `text()`.
   *
   * A fresh array each call, so a caller cannot mutate the buffered chunks —
   * the tracker hands the same `RemoteResponse` to `parse` and to its own
   * failure reporting.
   *
   * The return type pins the backing store to a real `ArrayBuffer` (rather than
   * the default `ArrayBufferLike`), which is what the platform's `BufferSource`
   * parameters — `crypto.subtle.digest`, `Blob`, `fetch` — require. It is true
   * by construction here, so pinning it saves every caller a cast.
   */
  bytes(): Uint8Array<ArrayBuffer> {
    const combined = new Uint8Array(this.byteLength)
    let offset = 0
    for (const chunk of this.#chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    return combined
  }

  /**
   * The body decoded as UTF-8.
   *
   * @returns Every buffered chunk concatenated and UTF-8 decoded
   *
   * @remarks
   * Lossy for a body that is not valid UTF-8 — see {@link bytes}.
   */
  text(): string {
    return new TextDecoder().decode(this.bytes())
  }
}

export { RemoteResponse }
export type { RemoteResponseHeaders }
