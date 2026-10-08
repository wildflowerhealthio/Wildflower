import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as RunPolicyChoice from './run-policy-choice.ts'
import * as RunPolicy from './run-policy.ts'

describe('toRunPolicyAt', () => {
  it('should store a choice of an hour as until an hour from now', () => {
    // Arrange
    const now = DateTime.unsafeMake('2026-10-08T14:57:00Z')

    // Act
    const policy = RunPolicyChoice.toRunPolicyAt({ kind: 'for', seconds: 60 * 60 }, now)

    // Assert
    expect(policy).toEqual({ kind: 'until', at: DateTime.unsafeMake('2026-10-08T15:57:00Z') })
  })

  it.each([[{ kind: 'off' }], [{ kind: 'whileOpen' }], [{ kind: 'always' }]] as const)(
    'should store %j as the policy of its own kind',
    (choice) => {
      // Act
      const policy = RunPolicyChoice.toRunPolicyAt(choice, DateTime.unsafeMake(0))

      // Assert
      expect(policy).toEqual(choice)
    }
  )

  it('should always store a for as an until that has not ended at now, and has once its seconds pass', () => {
    fc.assert(
      fc.property(
        // The host refuses a deadline after the year 9999.
        fc.date({ noInvalidDate: true, max: new Date('9000-01-01T00:00:00Z') }),
        fc.integer({ min: 1 }),
        (today, seconds) => {
          // Arrange
          const now = DateTime.unsafeFromDate(today)

          // Act
          const policy = RunPolicyChoice.toRunPolicyAt({ kind: 'for', seconds }, now)

          // Assert
          expect(RunPolicy.hasEndedAt(policy, now)).toBe(false)
          expect(RunPolicy.hasEndedAt(policy, DateTime.add(now, { seconds }))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
