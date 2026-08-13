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
 * instant the tracker observed that event. Everything an entity may know about a
 * response is here — the tracker never pre-extracts a slice of it.
 *
 * `id` and `startedAt` serve a *capturing* entity, one that records the exchange
 * rather than decoding a payload out of it; a decoding entity ignores both. See
 * the per-member notes for why each is on the response rather than re-derived.
 */
class RemoteResponse {
  #chunks: Uint8Array[] = []

  constructor(
    /**
     * The sniffer's per-request correlation key — its identity for this
     * exchange. A capturing entity keys stored records on it (e.g.
     * `{sessionId}-{requestId}`) so a retried write is an idempotent upsert
     * rather than a duplicate. Threading a counter through `parse` instead would
     * re-derive an id the sniffer already assigned and lose that idempotency.
     */
    public readonly id: typeof SnifferRequestId.Type,
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly headers: RemoteResponseHeaders,
    /**
     * When the tracker observed `ResponseStart` — the only instant on the
     * response the sniffer reports. `parse` runs at *settle*, so a capturing
     * entity that reads its own clock there would label the response's end as
     * its beginning; this carries the true start instant to that point.
     */
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
   * The lossless counterpart to {@link text}: a body that is not valid UTF-8 (an
   * image, a protobuf, a gzip the shim did not decode) survives here but comes
   * back from `text()` peppered with U+FFFD, and a re-encode of that string is
   * not the body that arrived. An entity that stores, hashes, or forwards a body
   * must read it through this; one decoding a known-JSON payload can keep to
   * `text()`.
   *
   * A fresh array each call, so a caller cannot mutate the buffered chunks. Its
   * `ArrayBuffer` backing store is pinned rather than left `ArrayBufferLike`
   * because that is what platform `BufferSource` parameters
   * (`crypto.subtle.digest`, `Blob`, `fetch`) accept — true by construction
   * here, so pinning it saves every caller a cast.
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
