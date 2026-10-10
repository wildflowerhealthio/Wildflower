import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as PebbleWatch from './pebble-watch.ts'

const RUNS = numRunsFor({ base: 50 })

const keysArbitrary = fc.array(fc.string(), { minLength: 1, maxLength: 3 })

describe('PebbleWatch.watchOf', () => {
  test('property: is the same watch for the same keys, with a 32-hex-digit token', () => {
    fc.assert(
      fc.property(keysArbitrary, (keys) => {
        const watch = PebbleWatch.watchOf(keys)
        expect(PebbleWatch.watchOf([...keys])).toEqual(watch)
        expect(watch.token).toMatch(/^[0-9a-f]{32}$/)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: different keys give different tokens', () => {
    fc.assert(
      fc.property(keysArbitrary, keysArbitrary, (left, right) => {
        fc.pre(JSON.stringify(left) !== JSON.stringify(right))
        expect(PebbleWatch.watchOf(left).token).not.toBe(PebbleWatch.watchOf(right).token)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('PebbleWatch.toReference', () => {
  test('property: is the device the phone writes, a Pebble Time 2 named by its token', () => {
    fc.assert(
      fc.property(keysArbitrary, (keys) => {
        const watch = PebbleWatch.watchOf(keys)
        const reference = PebbleWatch.toReference(watch)
        expect(reference.display).toMatch(/^pebble_time_2_black \(emery, firmware 4\.9\.[01]\)$/)
        expect(reference.identifier).toEqual({
          system: 'https://developer.repebble.com/docs/pebblekit-js/Pebble/#getWatchToken',
          value: watch.token,
        })
      }),
      { numRuns: RUNS }
    )
  })
})
