/**
 * RFC 8628 §6.1 user_code generation.
 *
 * Alphabet: 20 unambiguous consonants. The default 8-char shape is two
 * blocks of 4 (e.g. "BCDF-GHJK") for ~1.6 × 10^10 distinct codes —
 * enough that brute-forcing under the 5-minute TTL of an
 * `authorizationRequests` row is infeasible without rate limiting (the
 * device-flow approval endpoint also requires a valid Owner Bearer
 * token).
 *
 * Random bytes are pulled through the `CryptoRandomByte` service so
 * tests can drive `generateUserCode` deterministically. The live
 * implementation in `CryptoRandomByteLayerLive` uses
 * `crypto.getRandomValues` with rejection sampling to avoid modulo
 * bias.
 */

import { Context, Effect, Layer } from 'effect'

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const BLOCK_LENGTH = 4
const BLOCK_COUNT = 2

// Largest multiple of ALPHABET.length that fits in a byte; sampling
// from `[0, limit)` avoids modulo bias.
const REJECTION_LIMIT = 256 - (256 % ALPHABET.length)

class CryptoRandomByte extends Context.Tag('CryptoRandomByte')<
  CryptoRandomByte,
  { readonly next: Effect.Effect<number> }
>() {}

const CryptoRandomByteLayerLive: Layer.Layer<CryptoRandomByte> = Layer.succeed(CryptoRandomByte, {
  next: Effect.suspend(() => {
    const buf = new Uint8Array(1)
    crypto.getRandomValues(buf)
    const byte = buf[0]
    if (byte === undefined) {
      // Web Crypto guarantees the buffer is filled. Treat a missing byte
      // as a runtime invariant violation rather than silently retrying
      // or defaulting to a fixed value.
      return Effect.die(new Error('crypto.getRandomValues did not fill buffer'))
    }
    return Effect.succeed(byte)
  }),
})

const sampleAlphabetChar: Effect.Effect<string, never, CryptoRandomByte> = Effect.gen(function* () {
  const cryptoByte = yield* CryptoRandomByte
  for (;;) {
    const byte = yield* cryptoByte.next
    if (byte < REJECTION_LIMIT) {
      const char = ALPHABET[byte % ALPHABET.length]
      if (char === undefined) {
        // `byte % ALPHABET.length` is in `[0, ALPHABET.length)`; missing
        // index would mean `ALPHABET` was mutated underfoot.
        return yield* Effect.die(new Error('user_code alphabet index out of range'))
      }
      return char
    }
  }
})

const generateUserCode: Effect.Effect<string, never, CryptoRandomByte> = Effect.gen(function* () {
  const blocks: string[] = []
  for (let block = 0; block < BLOCK_COUNT; block++) {
    const chars: string[] = []
    for (let i = 0; i < BLOCK_LENGTH; i++) {
      chars.push(yield* sampleAlphabetChar)
    }
    blocks.push(chars.join(''))
  }
  return blocks.join('-')
})

const USER_CODE_REGEX = new RegExp(
  `^[${ALPHABET}]{${BLOCK_LENGTH}}(?:-[${ALPHABET}]{${BLOCK_LENGTH}}){${BLOCK_COUNT - 1}}$`
)

const isValidUserCode = (value: string): boolean => USER_CODE_REGEX.test(value)

export {
  ALPHABET,
  BLOCK_COUNT,
  BLOCK_LENGTH,
  CryptoRandomByte,
  CryptoRandomByteLayerLive,
  generateUserCode,
  isValidUserCode,
}
