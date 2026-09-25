import { Option, pipe, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { Lift } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

describe('first', () => {
  it('should read the first accepted entry and remove exactly that one', () => {
    // Act
    const lifted = firstEven([1, 2, 3, 4])

    // Assert — the later even entry is kept, never consulted.
    expect(lifted).toEqual(Option.some({ value: 2, remaining: [1, 3, 4] }))
  })

  it('should always remove only the entry it read, keeping everything around it', () => {
    fc.assert(
      fc.property(fc.array(odd), even, fc.array(fc.integer()), (skipped, readEntry, afterwards) => {
        // Arrange
        const entries = [...skipped, readEntry, ...afterwards]

        // Act
        const lifted = firstEven(entries)

        // Assert
        expect(lifted).toEqual(
          Option.some({ value: readEntry, remaining: [...skipped, ...afterwards] })
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read nothing from a list with no accepted entry', () => {
    fc.assert(
      fc.property(fc.array(odd), (entries) => {
        expect(firstEven(entries)).toEqual(Option.none())
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('firstDecoding', () => {
  it('should skip entries that do not decode and read the first that does', () => {
    // Arrange
    const entries = [{ dose: 'twenty' }, 'not an object', { dose: 20 }, { dose: 40 }]

    // Act
    const lifted = Lift.firstDecoding(Dose)(entries)

    // Assert
    expect(lifted).toEqual(
      Option.some({
        value: { dose: 20 },
        remaining: [{ dose: 'twenty' }, 'not an object', { dose: 40 }],
      })
    )
  })
})

describe('filter', () => {
  it('should read nothing and consume nothing when the value is rejected', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (entries) => {
        // Arrange
        const rejecting = pipe(
          firstEven,
          Lift.filter(() => false)
        )

        // Act
        const kept = Lift.drop(rejecting)(entries)

        // Assert
        expect(rejecting(entries)).toEqual(Option.none())
        expect(kept).toBe(entries)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('orElse', () => {
  it('should read with the fallback from the untouched list when the first reads nothing', () => {
    fc.assert(
      fc.property(fc.array(odd, { minLength: 1 }), (entries) => {
        // Arrange
        const evenOrElseAny = pipe(firstEven, Lift.orElse(firstAny))

        // Act
        const lifted = evenOrElseAny(entries)

        // Assert
        expect(lifted).toEqual(firstAny(entries))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('zipRight', () => {
  it('should consume both entries and yield the second value', () => {
    // Arrange — a source marker and a store number, as two separate entries.
    const entries = ['store:1234', 'note', 'source:rexall']
    const storeNumber = pipe(prefixed('source:'), Lift.zipRight(prefixed('store:')))

    // Act
    const lifted = storeNumber(entries)

    // Assert
    expect(lifted).toEqual(Option.some({ value: '1234', remaining: ['note'] }))
  })

  it('should read nothing, and consume nothing, when either half is missing', () => {
    // Arrange
    const storeNumber = pipe(prefixed('source:'), Lift.zipRight(prefixed('store:')))

    // Act / Assert
    expect(storeNumber(['store:1234'])).toEqual(Option.none())
    expect(storeNumber(['source:rexall'])).toEqual(Option.none())
  })
})

describe('map', () => {
  it('should transform the value without changing what is consumed', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (entries) => {
        // Arrange
        const halved = pipe(
          firstEven,
          Lift.map((value) => value / 2)
        )

        // Act / Assert
        expect(Option.map(halved(entries), ({ remaining }) => remaining)).toEqual(
          Option.map(firstEven(entries), ({ remaining }) => remaining)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const even = fc.integer().map((n) => n * 2)
const odd = fc.integer().map((n) => n * 2 + 1)

const firstEven = Lift.first((entry: number) => Option.liftPredicate(entry, (n) => n % 2 === 0))
const firstAny = Lift.first((entry: number) => Option.some(entry))

/** The rest of the first entry that starts with `prefix`. */
const prefixed = (prefix: string): Lift.Lift<string, string> =>
  Lift.first((entry: string) =>
    entry.startsWith(prefix) ? Option.some(entry.slice(prefix.length)) : Option.none()
  )

const Dose = Schema.Struct({ dose: Schema.Number })
