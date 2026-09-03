import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { dedupeMedicationsByName } from './dedupe.ts'
import type { Medication } from './medication.ts'

describe('dedupeMedicationsByName', () => {
  it('should keep the most recent instance of a duplicated name', () => {
    // Arrange
    const older: Medication = { id: 'a', displayName: 'Tylenol', authoredOn: '2023-01-01' }
    const newer: Medication = { id: 'b', displayName: 'Tylenol', authoredOn: '2024-06-01' }

    // Act
    const result = dedupeMedicationsByName([older, newer])

    // Assert
    expect(result).toEqual([newer])
  })

  it('should treat a missing authoredOn as the oldest', () => {
    const undated: Medication = { id: 'a', displayName: 'Tylenol' }
    const dated: Medication = { id: 'b', displayName: 'Tylenol', authoredOn: '2020-01-01' }
    expect(dedupeMedicationsByName([undated, dated])).toEqual([dated])
    expect(dedupeMedicationsByName([dated, undated])).toEqual([dated])
  })

  it('should keep distinct names apart, even when they only differ by strength', () => {
    const plain: Medication = { id: 'a', displayName: 'Tylenol' }
    const strength: Medication = { id: 'b', displayName: 'Tylenol 500mg' }
    expect(dedupeMedicationsByName([plain, strength])).toEqual([plain, strength])
  })

  it('should always return one medication per distinct name', () => {
    fc.assert(
      fc.property(medicationsArb, (medications) => {
        const names = dedupeMedicationsByName(medications).map((m) => m.displayName)
        expect(names).toEqual([...new Set(names)])
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should only ever return medications that were given to it', () => {
    fc.assert(
      fc.property(medicationsArb, (medications) => {
        for (const survivor of dedupeMedicationsByName(medications)) {
          expect(medications).toContain(survivor)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should keep the newest instance for every name', () => {
    fc.assert(
      fc.property(medicationsArb, (medications) => {
        for (const survivor of dedupeMedicationsByName(medications)) {
          const sameName = medications.filter((m) => m.displayName === survivor.displayName)
          for (const other of sameName) {
            // No sibling is strictly newer than the survivor.
            expect(after(other, survivor)).toBe(false)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should be idempotent', () => {
    fc.assert(
      fc.property(medicationsArb, (medications) => {
        const once = dedupeMedicationsByName(medications)
        expect(dedupeMedicationsByName(once)).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should preserve each name in first-appearance order', () => {
    fc.assert(
      fc.property(medicationsArb, (medications) => {
        const firstSeen = [...new Set(medications.map((m) => m.displayName))]
        const result = dedupeMedicationsByName(medications).map((m) => m.displayName)
        expect(result).toEqual(firstSeen)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

// Helpers

/** Strictly-after by `authoredOn`, with a missing date counting as oldest. */
const after = (a: Medication, b: Medication): boolean => {
  if (a.authoredOn === undefined) return false
  if (b.authoredOn === undefined) return true
  return a.authoredOn > b.authoredOn
}

/** Medications drawn from a small name/date pool so duplicates actually collide. */
const medicationArb: fc.Arbitrary<Medication> = fc
  .record({
    id: fc.uuid(),
    displayName: fc.constantFrom('Tylenol', 'Advil', 'Warfarin'),
    authoredOn: fc.option(fc.constantFrom('2020-01-01', '2022-06-15', '2024-12-31'), {
      nil: undefined,
    }),
  })
  .map(({ id, displayName, authoredOn }) => ({ id, displayName, authoredOn }))

const medicationsArb: fc.Arbitrary<readonly Medication[]> = fc.array(medicationArb, {
  maxLength: 12,
})
