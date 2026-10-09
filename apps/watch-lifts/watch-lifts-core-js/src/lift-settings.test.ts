import { Arbitrary, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as LiftSettings from './lift-settings.ts'
import * as Lifts from './lifts.ts'

const settingsArbitrary = Arbitrary.make(LiftSettings.Schema)

describe('Schema', () => {
  it('should accept the defaults', () => {
    expect(LiftSettings.fromJson(JSON.stringify(LiftSettings.DEFAULT))).toStrictEqual(
      Either.right(LiftSettings.DEFAULT)
    )
  })

  it('should generate a row per person and a weight per exercise', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(settings.weights).toHaveLength(Lifts.PEOPLE.length)
        for (const row of settings.weights) {
          expect(row).toHaveLength(Lifts.EXERCISES.length)
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('toJson', () => {
  it('should write the weights, person-major, under "weights"', () => {
    expect(LiftSettings.toJson(LiftSettings.DEFAULT)).toBe(
      '{"weights":[[60,50,50,50,85],[65,55,55,45,85]]}'
    )
  })
})

describe('fromJson', () => {
  it('should read back whatever toJson writes', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(LiftSettings.fromJson(LiftSettings.toJson(settings))).toStrictEqual(
          Either.right(settings)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    ['a weight over 999', '{"weights":[[1000,50,50,50,85],[65,55,55,45,85]]}'],
    ['a negative weight', '{"weights":[[-5,50,50,50,85],[65,55,55,45,85]]}'],
    ['a fractional weight', '{"weights":[[62.5,50,50,50,85],[65,55,55,45,85]]}'],
    ['a weight as text', '{"weights":[["60",50,50,50,85],[65,55,55,45,85]]}'],
    ['a short row', '{"weights":[[60,50,50,50],[65,55,55,45,85]]}'],
    ['one person', '{"weights":[[60,50,50,50,85]]}'],
    ['no weights', '{}'],
    ['text that is not JSON', 'weights'],
  ])('should refuse %s', (_, json) => {
    expect(Either.isLeft(LiftSettings.fromJson(json))).toBe(true)
  })
})
