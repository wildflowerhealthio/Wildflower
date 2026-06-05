import { Effect, Stream } from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { WebApiOrigin } from './index.ts'

// A scheme + host with no trailing slash or punctuation, so it satisfies
// `layerFromLiteral`'s alphanumeric-suffix guard. `fc.domain()` always
// ends in a TLD letter.
const originArb = fc
  .tuple(fc.constantFrom('http://', 'https://'), fc.domain())
  .map(([scheme, host]) => `${scheme}${host}`)

describe('WebApiOrigin.layerFromLiteral', () => {
  test('get yields the literal origin the layer was built from', async () => {
    const origin = 'http://127.0.0.1:8080'
    const result = await Effect.runPromise(
      WebApiOrigin.get.pipe(Effect.provide(WebApiOrigin.layerFromLiteral(origin)))
    )
    expect(result).toBe(origin)
  })

  test('changes emits the literal origin', async () => {
    const origin = 'http://localhost:3000'
    const emitted = await Effect.runPromise(
      WebApiOrigin.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(WebApiOrigin.layerFromLiteral(origin))
      )
    )
    expect(emitted).toEqual([origin])
  })

  test('get round-trips any scheme+host origin (property)', async () => {
    await fc.assert(
      fc.asyncProperty(originArb, async (origin) => {
        const result = await Effect.runPromise(
          WebApiOrigin.get.pipe(Effect.provide(WebApiOrigin.layerFromLiteral(origin)))
        )
        expect(result).toBe(origin)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('rejects an origin that ends with a trailing slash', () => {
    expect(() => WebApiOrigin.layerFromLiteral('http://localhost/')).toThrow(
      /must end with an alphanumeric character/
    )
  })

  test('accepts an origin ending in a port digit', () => {
    expect(() => WebApiOrigin.layerFromLiteral('http://localhost:8081')).not.toThrow()
  })
})
