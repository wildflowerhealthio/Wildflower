import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  addTallies,
  compareTallies,
  type SeverityTally,
  tallyOf,
  tallyTotal,
  worstSeverity,
} from './dots.ts'
import { severityCodes } from './severity.ts'

describe('worstSeverity', () => {
  it('should return the most severe severity present', () => {
    expect(worstSeverity({ major: 0, moderate: 2, minor: 0, unknown: 3 })).toBe('moderate')
  })

  it('should return null for an empty tally', () => {
    expect(worstSeverity({ major: 0, moderate: 0, minor: 0, unknown: 0 })).toBeNull()
  })

  it('should always return the first severity, in rank order, with a nonzero count', () => {
    fc.assert(
      fc.property(tallyArb, (tally) => {
        const expected = severityCodes.find((severity) => tally[severity] > 0) ?? null
        expect(worstSeverity(tally)).toBe(expected)
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
