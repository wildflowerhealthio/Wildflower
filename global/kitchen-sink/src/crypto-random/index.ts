/**
 * `CryptoRandom` is an Effect Service that abstracts the two
 * non-deterministic primitives needed by this codebase: a single
 * uniformly-distributed byte and a v4 UUID. Lifting them behind a
 * service lets tests provide deterministic stubs (counter or seeded
 * PRNG) while production binds the platform's Web Crypto.
 *
 * `kitchen-sink` is platform-agnostic — it does not reach for any
 * global `crypto` object. Callers pass in their platform's crypto
 * (browser `window.crypto`, Node `node:crypto.webcrypto`, an Expo
 * polyfill, etc.) when constructing the live layer.
 */

import { Context, Effect, Layer } from 'effect'

/**
 * Minimum structural shape required from the platform's Web Crypto
 * implementation. Both browser `Crypto` and Node's `webcrypto` satisfy
 * this; an Expo / React Native polyfill that exposes the same two
 * methods does too.
 */
interface CryptoLike<TByteArray> {
  getRandomValues(array: TByteArray): TByteArray
  randomUUID(): string
}

class CryptoRandom extends Context.Tag('CryptoRandom')<
  CryptoRandom,
  {
    readonly nextByte: Effect.Effect<number>
    readonly nextUuid: Effect.Effect<string>
  }
>() {}

/**
 * Live `CryptoRandom` backed by the supplied platform crypto. Pass the
 * platform's Web Crypto: `globalThis.crypto` in the browser,
 * `node:crypto.webcrypto` on Node, etc.
 */
const CryptoRandomLayerLive = <TByteArray extends ArrayLike<number>>(
  crypto: CryptoLike<TByteArray>,
  byteArray: TByteArray
): Layer.Layer<CryptoRandom> =>
  Layer.succeed(CryptoRandom, {
    nextByte: Effect.suspend(() => {
      crypto.getRandomValues(byteArray)
      const byte = byteArray[0]
      if (byte === undefined) {
        // Web Crypto guarantees the buffer is filled. Treat a missing
        // byte as a runtime invariant violation.
        return Effect.die(new Error('crypto.getRandomValues did not fill buffer'))
      }
      return Effect.succeed(byte)
    }),
    nextUuid: Effect.sync(() => crypto.randomUUID()),
  })

/**
 * Test stub that emits `0, 1, 2, …, 255, 0, 1, …` for bytes and
 * `"<prefix>-0001"`, `"<prefix>-0002"`, … for UUIDs. Use when you want
 * deterministic outputs and don't need to assert specific values.
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

/**
 * Test stub backed by a seeded mulberry32 PRNG. Same seed → same
 * sequence of bytes and v4-shaped UUIDs. Use for property-based tests
 * where you want variety without flakiness.
 */
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

export type { CryptoLike }
export { CryptoRandom, CryptoRandomLayerLive, cryptoRandomCounter, cryptoRandomFromSeed }
