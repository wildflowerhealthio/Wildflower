import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHostCDriver,
  type HostCDriver,
  numRunsFor,
} from '@wildflowerhealthio/kitchen-sink/test'
import { Lifts } from '@wildflowerhealthio/watch-lifts-core-js/pkjs'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// state.c holds what the menu shows, and keeps the weights in persist
// storage. It includes pebble.h, so buildHostCDriver builds it against the
// stand-in in pebble-stand-in/, whose persist storage state-driver.c keeps in
// memory for one scenario (one driver command line) at a time.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'watch-lifts-state',
    sources: [join(packageDir, 'test/state-driver.c'), join(packageDir, 'src/c/state.c')],
    includeDirectories: [join(packageDir, 'test/pebble-stand-in')],
  })
})

afterAll(() => {
  driver.dispose()
})

/** Runs `steps` as one scenario and returns each step's output. */
const runScenario = (steps: ReadonlyArray<string>): ReadonlyArray<string> =>
  driver.run(steps.join('; ')).split('; ')

const weightsText = (weights: ReadonlyArray<ReadonlyArray<number>>): string =>
  weights.flat().join(' ')

const weightsArbitrary = fc.array(
  fc.array(fc.integer({ min: 0, max: Lifts.MAX_WEIGHT }), {
    minLength: Lifts.EXERCISES.length,
    maxLength: Lifts.EXERCISES.length,
  }),
  { minLength: Lifts.PEOPLE.length, maxLength: Lifts.PEOPLE.length }
)

/** state.c's PersistKeyWeights. */
const PERSIST_KEY_WEIGHTS = 1

// watch-lifts-core-js's Lifts mirrors state.c, and the settings page and the
// phone build on it; a change on one side alone would label or place weights
// wrongly.
describe("the core's Lifts", () => {
  it("should name state.c's exercises and people, in its order", () => {
    expect(runScenario(['exercises', 'people'])).toEqual([
      Lifts.EXERCISES.join('|'),
      Lifts.PEOPLE.join('|'),
    ])
  })

  it("should hold state.c's default weights", () => {
    expect(runScenario(['load', 'weights'])).toEqual(['loaded', weightsText(Lifts.DEFAULT_WEIGHTS)])
  })
})

describe('state_set_weights', () => {
  it('should keep the weights across a restart', () => {
    fc.assert(
      fc.property(weightsArbitrary, (weights) => {
        expect(
          runScenario(['load', `set ${weightsText(weights)}`, 'weights', 'restart', 'weights'])
        ).toEqual(['loaded', 'set', weightsText(weights), 'loaded', weightsText(weights)])
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  // An installed watch keeps its weights under the key across updates.
  it('should persist them under key 1 alone', () => {
    expect(runScenario(['load', `set ${weightsText(Lifts.DEFAULT_WEIGHTS)}`, 'keys'])).toEqual([
      'loaded',
      'set',
      String(PERSIST_KEY_WEIGHTS),
    ])
  })
})

describe('state_load', () => {
  it('should fall back to the defaults when what is persisted is another size', () => {
    fc.assert(
      fc.property(fc.nat({ max: 256 }), (size) => {
        // 4-byte ints on the host as on the watch.
        fc.pre(size !== 4 * Lifts.PEOPLE.length * Lifts.EXERCISES.length)
        expect(
          runScenario([`persist ${PERSIST_KEY_WEIGHTS} ${size}`, 'restart', 'weights'])
        ).toEqual(['persisted', 'loaded', weightsText(Lifts.DEFAULT_WEIGHTS)])
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
