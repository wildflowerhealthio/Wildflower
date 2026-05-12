import type { ReadonlyRecord } from 'effect/Record'

class RemoteResponse {
  #chunks: Uint8Array[] = []

  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly headers: ReadonlyRecord<string, string>
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
