import { Effect, type Layer } from 'effect'
import * as fc from 'fast-check'
import { expect, test } from 'vite-plus/test'
import {
  CryptoRandom,
  type CryptoLike,
  CryptoRandomLayerLive,
  cryptoRandomCounter,
  cryptoRandomFromSeed,
  cryptoRandomLayerFromWebCrypto,
} from './index.ts'

const drainBytes = (layer: Layer.Layer<CryptoRandom>, count: number): ReadonlyArray<number> =>
  Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* CryptoRandom
        const out: number[] = []
        for (let i = 0; i < count; i++) out.push(yield* svc.nextByte)
        return out
      }),
      layer
    )
  )

const drainUuids = (layer: Layer.Layer<CryptoRandom>, count: number): ReadonlyArray<string> =>
  Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* CryptoRandom
        const out: string[] = []
        for (let i = 0; i < count; i++) out.push(yield* svc.nextUuid)
        return out
      }),
      layer
    )
  )

test('cryptoRandomCounter emits sequential bytes 0,1,2,…,255,0,…', () => {
  const layer = cryptoRandomCounter()
  const bytes = drainBytes(layer, 260)
  expect(bytes.slice(0, 5)).toEqual([0, 1, 2, 3, 4])
  expect(bytes[255]).toBe(255)
  expect(bytes[256]).toBe(0)
  expect(bytes[259]).toBe(3)
})

test('cryptoRandomCounter emits zero-padded sequential UUIDs with default prefix', () => {
  const layer = cryptoRandomCounter()
  const uuids = drainUuids(layer, 3)
  expect(uuids).toEqual(['uuid-0001', 'uuid-0002', 'uuid-0003'])
})

test('cryptoRandomCounter respects the custom uuidPrefix', () => {
  const layer = cryptoRandomCounter({ uuidPrefix: 'authcode' })
  const uuids = drainUuids(layer, 2)
  expect(uuids).toEqual(['authcode-0001', 'authcode-0002'])
})

test('cryptoRandomFromSeed is reproducible: same seed → same sequence', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
      const a = drainBytes(cryptoRandomFromSeed(seed), 32)
      const b = drainBytes(cryptoRandomFromSeed(seed), 32)
      expect(a).toEqual(b)
    }),
    { numRuns: 16 }
  )
})

test('cryptoRandomFromSeed produces v4-shaped UUIDs', () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
      const uuids = drainUuids(cryptoRandomFromSeed(seed), 4)
      for (const u of uuids) expect(u).toMatch(v4)
    }),
    { numRuns: 8 }
  )
})

test('cryptoRandomFromSeed produces bytes in [0, 256)', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
      const bytes = drainBytes(cryptoRandomFromSeed(seed), 64)
      for (const b of bytes) {
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThan(256)
      }
    }),
    { numRuns: 8 }
  )
})

test('CryptoRandomLayerLive forwards to the supplied crypto.getRandomValues', () => {
  let calls = 0
  const fakeCrypto: CryptoLike<Uint8Array> = {
    getRandomValues: <T extends Uint8Array>(array: T): T => {
      calls++
      array[0] = 42
      return array
    },
    randomUUID: () => 'unused',
  }
  const bytes = drainBytes(CryptoRandomLayerLive(fakeCrypto, new Uint8Array(1)), 3)
  expect(bytes).toEqual([42, 42, 42])
  expect(calls).toBe(3)
})

test('CryptoRandomLayerLive forwards to the supplied crypto.randomUUID', () => {
  let calls = 0
  const fakeCrypto: CryptoLike<Uint8Array> = {
    getRandomValues: <T extends Uint8Array>(a: T): T => a,
    randomUUID: () => {
      calls++
      return `id-${calls}`
    },
  }
  const uuids = drainUuids(CryptoRandomLayerLive(fakeCrypto, new Uint8Array(1)), 3)
  expect(uuids).toEqual(['id-1', 'id-2', 'id-3'])
})

test('cryptoRandomLayerFromWebCrypto wraps Web Crypto without an explicit type argument', () => {
  // Pins type inference: the helper binds `Uint8Array` internally so callers don't repeat it.
  const layer = cryptoRandomLayerFromWebCrypto(globalThis.crypto)
  const bytes = drainBytes(layer, 4)
  expect(bytes).toHaveLength(4)
  for (const b of bytes) {
    expect(b).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThan(256)
  }
})
