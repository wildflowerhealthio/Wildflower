import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  addTallies,
  allocateDots,
  compareTallies,
  dotCap,
  type SeverityTally,
  tallyOf,
  tallyTotal,
} from './dots.ts'
import { type Severity, severityCodes, severityRank } from './severity.ts'

describe('allocateDots', () => {
  it('should give every interaction its own dot while the cap allows', () => {
    // Arrange
    const tally: SeverityTally = { major: 1, moderate: 2, minor: 0, unknown: 3 }

    // Act
    const dots = allocateDots(tally)

    // Assert
    expect(dots).toEqual(['major', 'moderate', 'moderate', 'unknown', 'unknown', 'unknown'])
  })

  it('should keep a lone Major visible in a group dominated by Unknowns', () => {
    const dots = allocateDots({ major: 1, moderate: 0, minor: 0, unknown: 99 })
    expect(dots).toEqual(['major', ...Array.from<Severity>({ length: 13 }).fill('unknown')])
  })

  it('should return no dots for an empty tally', () => {
    expect(allocateDots({ major: 0, moderate: 0, minor: 0, unknown: 0 })).toEqual([])
  })

  it('should always return exactly one dot per interaction up to the cap', () => {
    fc.assert(
      fc.property(tallyArb, capArb, (tally, cap) => {
        const dots = allocateDots(tally, cap)
        expect(dots).toHaveLength(Math.min(tallyTotal(tally), cap))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always paint the exact counts when the total is within the cap', () => {
    fc.assert(
      fc.property(
        capArb.chain((cap) => fc.tuple(fc.constant(cap), withinCapArb(cap))),
        ([cap, tally]) => {
          expect(tallyOf(allocateDots(tally, cap).map((severity) => ({ severity })))).toEqual(tally)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always show every severity present when the total exceeds the cap', () => {
    fc.assert(
      fc.property(tallyArb, capArb, (tally, cap) => {
        fc.pre(tallyTotal(tally) > cap)
        const painted = tallyOf(allocateDots(tally, cap).map((severity) => ({ severity })))
        for (const severity of severityCodes) {
          if (tally[severity] > 0) expect(painted[severity]).toBeGreaterThanOrEqual(1)
          else expect(painted[severity]).toBe(0)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never give a severity more dots than a more frequent one, beyond rounding', () => {
    fc.assert(
      fc.property(tallyArb, capArb, (tally, cap) => {
        const painted = tallyOf(allocateDots(tally, cap).map((severity) => ({ severity })))
        for (const a of severityCodes) {
          for (const b of severityCodes) {
            if (tally[a] > tally[b]) expect(painted[a]).toBeGreaterThanOrEqual(painted[b])
          }
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always order dots most severe first', () => {
    fc.assert(
      fc.property(tallyArb, capArb, (tally, cap) => {
        const ranks = allocateDots(tally, cap).map((severity) => severityRank[severity])
        expect(ranks).toEqual(ranks.toSorted((x, y) => x - y))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('compareTallies', () => {
  it('should rank one Major above any number of Moderates', () => {
    const oneMajor: SeverityTally = { major: 1, moderate: 0, minor: 0, unknown: 0 }
    const manyModerate: SeverityTally = { major: 0, moderate: 100, minor: 0, unknown: 0 }
    expect(compareTallies(oneMajor, manyModerate)).toBeLessThan(0)
  })

  it('should always agree with comparing the counts most severe first', () => {
    fc.assert(
      fc.property(tallyArb, tallyArb, (a, b) => {
        const expected = severityCodes.reduce(
          (decided, severity) => (decided !== 0 ? decided : Math.sign(b[severity] - a[severity])),
          0
        )
        expect(Math.sign(compareTallies(a, b))).toBe(expected)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('tallyOf', () => {
  it('should always count each severity and nothing else', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...severityCodes)), (severities) => {
        const tally = tallyOf(severities.map((severity) => ({ severity })))
        for (const severity of severityCodes) {
          expect(tally[severity]).toBe(severities.filter((s) => s === severity).length)
        }
        expect(tallyTotal(tally)).toBe(severities.length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('addTallies', () => {
  it('should always sum totals', () => {
    fc.assert(
      fc.property(tallyArb, tallyArb, (a, b) => {
        expect(tallyTotal(addTallies(a, b))).toBe(tallyTotal(a) + tallyTotal(b))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const tallyArb: fc.Arbitrary<SeverityTally> = fc.record({
  major: fc.nat(),
  moderate: fc.nat(),
  minor: fc.nat(),
  unknown: fc.nat(),
})

/** A tally of at most `cap` interactions. */
const withinCapArb = (cap: number): fc.Arbitrary<SeverityTally> =>
  fc
    .array(fc.constantFrom(...severityCodes), { maxLength: cap })
    .map((severities) => tallyOf(severities.map((severity) => ({ severity }))))

/** Caps from the smallest that can show all four severities up to the production value. */
const capArb = fc.integer({ min: severityCodes.length, max: dotCap })
