import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { buildHostCDriver, type HostCDriver, numRunsFor } from 'kitchen-sink/test'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { Lifts, PhoneSettings } from 'watch-lifts-core/pkjs'

// weights-wire.c decodes the weights the phone sends, and watch-lifts-core's
// PhoneSettings.toWatchMessage encodes them. The watch side needs no SDK to
// test: buildHostCDriver compiles it with the host C compiler under the
// sanitizers, driven through weights-wire-driver.c, and these tests feed it
// the phone's bytes to hold the two sides of the wire together.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver
/** The layout weights-wire.h and state.h set, read from the driver in beforeAll. */
let wireSize: number
let peopleCount: number
let exerciseCount: number
let maxWeight: number
let inboxSize: number

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'watch-lifts-weights-wire',
    sources: [
      join(packageDir, 'test/weights-wire-driver.c'),
      join(packageDir, 'src/c/weights-wire.c'),
    ],
  })
  ;[wireSize = 0, peopleCount = 0, exerciseCount = 0, maxWeight = 0, inboxSize = 0] = driver
    .run('sizes')
    .split(' ')
    .map(Number)
})

afterAll(() => {
  driver.dispose()
})

const decode = (bytes: ReadonlyArray<number>): string => driver.run(['decode', ...bytes].join(' '))

/** What the driver prints for weights the decode accepted. */
const decoded = (weights: ReadonlyArray<ReadonlyArray<number>>): string =>
  ['ok', ...weights.flat()].join(' ')

/** What the driver prints for a rejected message: the out array as it was. */
const rejected = (): string =>
  ['rejected', ...Array.from({ length: peopleCount * exerciseCount }, () => -1)].join(' ')

const settingsArbitrary: fc.Arbitrary<PhoneSettings.Settings> = fc
  .array(
    fc.array(fc.integer({ min: 0, max: Lifts.MAX_WEIGHT }), {
      minLength: Lifts.EXERCISES.length,
      maxLength: Lifts.EXERCISES.length,
    }),
    { minLength: Lifts.PEOPLE.length, maxLength: Lifts.PEOPLE.length }
  )
  .map((weights) => ({ weights }))

describe('the layout', () => {
  it("should be the size, shape and limit the phone's message has", () => {
    expect(wireSize).toBe(PhoneSettings.WEIGHTS_BYTES)
    expect([peopleCount, exerciseCount]).toEqual([Lifts.PEOPLE.length, Lifts.EXERCISES.length])
    expect(maxWeight).toBe(Lifts.MAX_WEIGHT)
  })

  // dict_calc_buffer_size's formula: a 1-byte dictionary header, then per
  // tuple a 7-byte header and its value.
  it('should open an inbox that fits the Weights message', () => {
    expect(inboxSize).toBeGreaterThanOrEqual(1 + 7 + PhoneSettings.WEIGHTS_BYTES)
  })
})

describe('weights_wire_decode', () => {
  it("should decode any weights the phone sends to the phone's own weights", () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(decode(PhoneSettings.toWatchMessage(settings).Weights)).toBe(
          decoded(settings.weights)
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should decode the default weights', () => {
    expect(decode(PhoneSettings.toWatchMessage(PhoneSettings.DEFAULT).Weights)).toBe(
      decoded(Lifts.DEFAULT_WEIGHTS)
    )
  })

  it('should reject a message of any other length, leaving the weights alone', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 255 }), { maxLength: 48 }), (bytes) => {
        fc.pre(bytes.length !== wireSize)
        expect(decode(bytes)).toBe(rejected())
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should reject a weight over 999, leaving the weights alone', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: Lifts.PEOPLE.length * Lifts.EXERCISES.length - 1 }),
        fc.integer({ min: Lifts.MAX_WEIGHT + 1, max: 0xffff }),
        (settings, index, weight) => {
          const bytes = [...PhoneSettings.toWatchMessage(settings).Weights]
          bytes[2 * index] = weight & 0xff
          bytes[2 * index + 1] = weight >> 8
          expect(decode(bytes)).toBe(rejected())
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})
