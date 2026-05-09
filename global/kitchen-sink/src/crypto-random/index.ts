import { Context, Effect, Layer } from 'effect'

/** Minimum structural shape required from the platform's Web Crypto implementation. */
interface CryptoLike<TByteArray> {
  getRandomValues(array: TByteArray): TByteArray
  randomUUID(): string
}

/**
 * Effect Service for non-deterministic primitives: a single uniform
 * byte and a v4 UUID. Tests provide deterministic stubs; production
 * binds the platform's Web Crypto.
 */
class CryptoRandom extends Context.Tag('CryptoRandom')<
  CryptoRandom,
  {
    readonly nextByte: Effect.Effect<number>
    readonly nextUuid: Effect.Effect<string>
  }
>() {}

/** Live `CryptoRandom` backed by a generic `CryptoLike` shape. */
const CryptoRandomLayerLive = <TByteArray extends ArrayLike<number>>(
  crypto: CryptoLike<TByteArray>,
  byteArray: TByteArray
): Layer.Layer<CryptoRandom> =>
  Layer.succeed(CryptoRandom, {
    nextByte: Effect.suspend(() => {
      crypto.getRandomValues(byteArray)
      const byte = byteArray[0]
      if (byte === undefined) {
        return Effect.die(new Error('crypto.getRandomValues did not fill buffer'))
      }
      return Effect.succeed(byte)
    }),
    nextUuid: Effect.sync(() => crypto.randomUUID()),
  })

interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T
  randomUUID(): string
}

/**
 * Live `CryptoRandom` backed by a standard Web Crypto-shaped object —
 * `globalThis.crypto`, `node:crypto.webcrypto`, or an RN polyfill.
 */
const cryptoRandomLayerFromWebCrypto = (crypto: WebCryptoLike): Layer.Layer<CryptoRandom> =>
  CryptoRandomLayerLive<Uint8Array>(
    {
      getRandomValues: (array: Uint8Array) => crypto.getRandomValues(array),
      randomUUID: () => crypto.randomUUID(),
    },
    new Uint8Array(1)
  )

/**
 * Test stub: bytes cycle `0, 1, …, 255, 0, …`; UUIDs are `<prefix>-0001`,
 * `<prefix>-0002`, …
 */
const cryptoRandomCounter = (opts?: { uuidPrefix?: string }): Layer.Layer<CryptoRandom> => {
  let byteCount = 0
  let uuidCount = 0
  const prefix = opts?.uuidPrefix ?? 'uuid'
  return Layer.succeed(CryptoRandom, {
    nextByte: Effect.sync(() => {
      const value = byteCount & 0xff
      byteCount++
      return value
    }),
    nextUuid: Effect.sync(() => {
      uuidCount++
      return `${prefix}-${uuidCount.toString().padStart(4, '0')}`
    }),
  })
}

/** Test stub: seeded mulberry32 PRNG. Same seed reproduces the same byte and UUID sequence. */
const cryptoRandomFromSeed = (seed: number): Layer.Layer<CryptoRandom> => {
  let state = seed >>> 0
  const next32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  return Layer.succeed(CryptoRandom, {
    nextByte: Effect.sync(() => next32() & 0xff),
    nextUuid: Effect.sync(() => {
      const hex: string[] = []
      for (let i = 0; i < 16; i++) {
        let b = next32() & 0xff
        if (i === 6) b = (b & 0x0f) | 0x40 // version 4
        if (i === 8) b = (b & 0x3f) | 0x80 // RFC 4122 variant
        hex.push(b.toString(16).padStart(2, '0'))
      }
      const h = hex.join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }),
  })
}

export type { CryptoLike, WebCryptoLike }
export {
  CryptoRandom,
  CryptoRandomLayerLive,
  cryptoRandomCounter,
  cryptoRandomFromSeed,
  cryptoRandomLayerFromWebCrypto,
}
