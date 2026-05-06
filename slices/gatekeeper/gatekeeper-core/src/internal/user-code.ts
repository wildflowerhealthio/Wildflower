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
 * Random bytes are pulled through `CryptoRandom` (from kitchen-sink) so
 * tests can drive `generateUserCode` deterministically. Rejection
 * sampling is used to avoid modulo bias.
 */

import { Effect } from 'effect'
import { CryptoRandom } from 'kitchen-sink/crypto-random'

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const BLOCK_LENGTH = 4
const BLOCK_COUNT = 2

// Largest multiple of ALPHABET.length that fits in a byte; sampling
// from `[0, limit)` avoids modulo bias.
const REJECTION_LIMIT = 256 - (256 % ALPHABET.length)

const sampleAlphabetChar: Effect.Effect<string, never, CryptoRandom> = Effect.gen(function* () {
  const cryptoRandom = yield* CryptoRandom
  for (;;) {
    const byte = yield* cryptoRandom.nextByte
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

const generateUserCode: Effect.Effect<string, never, CryptoRandom> = Effect.gen(function* () {
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

export { ALPHABET, BLOCK_COUNT, BLOCK_LENGTH, generateUserCode, isValidUserCode }
