/**
 * Ordered `(name, value)` header pairs as received on the wire. HTTP
 * allows the same header name to appear repeatedly (`Set-Cookie` is
 * the canonical case); preserving the array shape keeps the response
 * lossless. Consumers that want lookup by name should use
 * `headersGet(this.headers, 'set-cookie')` (case-insensitive) or
 * fold into a `Map<string, string[]>`.
 */
type RemoteResponseHeaders = readonly (readonly [string, string])[]

class RemoteResponse {
  #chunks: Uint8Array[] = []

  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly headers: RemoteResponseHeaders
  ) {}

  appendChunk(chunk: Uint8Array): void {
    this.#chunks.push(chunk)
  }

  text(): string {
    const totalLength = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of this.#chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(combined)
  }
}

export { RemoteResponse }
export type { RemoteResponseHeaders }
