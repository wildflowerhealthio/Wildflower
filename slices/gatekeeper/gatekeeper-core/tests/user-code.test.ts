import { Effect, Layer } from 'effect'
import { CryptoRandom, CryptoRandomLayerLive } from 'kitchen-sink/crypto-random'
import { expect, test } from 'vite-plus/test'
import {
  ALPHABET,
  BLOCK_COUNT,
  BLOCK_LENGTH,
  generateUserCode,
  isValidUserCode,
} from '../src/internal/user-code.ts'

const LiveLayer = CryptoRandomLayerLive<
  Uint8Array & ReturnType<typeof globalThis.crypto.getRandomValues>
>(globalThis.crypto, new Uint8Array(1))

const runUserCode = (): string => Effect.runSync(Effect.provide(generateUserCode, LiveLayer))

const REJECTION_LIMIT = 256 - (256 % ALPHABET.length)

const stubBytes = (queue: ReadonlyArray<number>): Layer.Layer<CryptoRandom> => {
  let i = 0
  return Layer.succeed(CryptoRandom, {
    nextByte: Effect.sync(() => {
      const b = queue[i++]
      if (b === undefined) throw new Error('stub byte queue exhausted')
      return b
    }),
    nextUuid: Effect.sync(() => {
      throw new Error('user-code generation should not consume UUIDs')
    }),
  })
}

const runWithStub = (queue: ReadonlyArray<number>): string =>
  Effect.runSync(Effect.provide(generateUserCode, stubBytes(queue)))

test('generateUserCode produces a value matching the RFC 8628 alphabet', () => {
  expect(isValidUserCode(runUserCode())).toBe(true)
})

test('generateUserCode formats as XXXX-XXXX', () => {
  expect(runUserCode()).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
})

test('generateUserCode maps accepted bytes to alphabet via modulo', () => {
  // Bytes 0..3 in each block → ALPHABET[0..3] in each block.
  const code = runWithStub([0, 1, 2, 3, 0, 1, 2, 3])
  const block = ALPHABET.slice(0, BLOCK_LENGTH)
  expect(code).toBe(`${block}-${block}`)
})

test('generateUserCode rejects bytes ≥ REJECTION_LIMIT and resamples', () => {
  // First two bytes are out-of-range and must be skipped; the third
  // (0) is accepted and yields ALPHABET[0]. Repeat across the full code.
  const queue: number[] = []
  for (let i = 0; i < BLOCK_COUNT * BLOCK_LENGTH; i++) {
    queue.push(REJECTION_LIMIT, REJECTION_LIMIT + 7, 0)
  }
  const code = runWithStub(queue)
  const block = ALPHABET[0]?.repeat(BLOCK_LENGTH)
  expect(code).toBe(`${block}-${block}`)
})

test('generateUserCode pulls exactly BLOCK_COUNT × BLOCK_LENGTH bytes when none are rejected', () => {
  let pulls = 0
  const layer = Layer.succeed(CryptoRandom, {
    nextByte: Effect.sync(() => {
      pulls++
      return 0
    }),
    nextUuid: Effect.sync(() => {
      throw new Error('user-code generation should not consume UUIDs')
    }),
  })
  Effect.runSync(Effect.provide(generateUserCode, layer))
  expect(pulls).toBe(BLOCK_COUNT * BLOCK_LENGTH)
})

test('isValidUserCode rejects codes that contain alphabet outsiders', () => {
  expect(isValidUserCode('AAAA-AAAA')).toBe(false) // A is not in alphabet
  expect(isValidUserCode('1234-5678')).toBe(false)
  expect(isValidUserCode('BCDF-GHJK')).toBe(true)
  expect(
    isValidUserCode(`${ALPHABET.slice(0, BLOCK_LENGTH)}-${ALPHABET.slice(0, BLOCK_LENGTH)}`)
  ).toBe(true)
})

test('isValidUserCode rejects malformed shapes', () => {
  expect(isValidUserCode('BCDFGHJK')).toBe(false) // missing dash
  expect(isValidUserCode('BCDF-GHJ')).toBe(false) // too short
  expect(isValidUserCode('BCDFG-GHJK')).toBe(false) // wrong block size
})
