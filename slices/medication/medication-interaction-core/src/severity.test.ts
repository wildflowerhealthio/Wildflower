import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  compareSeverity,
  parseSeverity,
  Severity,
  severityCodes,
  severityFromCode,
  severityLabels,
  severityRank,
  severityToCode,
} from './severity.ts'

describe('parseSeverity', () => {
  it('should read the DDInter Level labels in any case and with padding', () => {
    expect(parseSeverity('Major')).toBe('major')
    expect(parseSeverity(' moderate ')).toBe('moderate')
    expect(parseSeverity('MINOR')).toBe('minor')
    expect(parseSeverity('Unknown')).toBe('unknown')
  })

  it('should return null for anything else', () => {
    expect(parseSeverity('')).toBeNull()
    expect(parseSeverity('Severe')).toBeNull()
  })

  it('should always round-trip a label back to its severity', () => {
    fc.assert(
      fc.property(Arbitrary.make(Severity), (severity) => {
        expect(parseSeverity(severityLabels[severity])).toBe(severity)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('severityFromCode', () => {
  it('should invert severityToCode for every severity', () => {
    fc.assert(
      fc.property(Arbitrary.make(Severity), (severity) => {
        expect(severityFromCode(severityToCode(severity))).toBe(severity)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should agree with the severityCodes table position', () => {
    for (const [index, severity] of severityCodes.entries()) {
      expect(severityRank[severity]).toBe(index)
    }
  })
})

describe('compareSeverity', () => {
  it('should order Major before Moderate before Minor before Unknown', () => {
    const shuffled: Severity[] = ['unknown', 'minor', 'major', 'moderate']
    expect(shuffled.toSorted(compareSeverity)).toEqual(['major', 'moderate', 'minor', 'unknown'])
  })

  it('should always be antisymmetric', () => {
    fc.assert(
      fc.property(Arbitrary.make(Severity), Arbitrary.make(Severity), (a, b) => {
        expect(compareSeverity(a, b) + compareSeverity(b, a)).toBe(0)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
