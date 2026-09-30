import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Prescription } from './prescription.ts'
import { localDateOf, type Session, sessionMet, sessionsOf } from './session.ts'
import { type SetResult, sortByStart } from './set-result.ts'
import {
  failedRepsArb,
  instantArb,
  prescriptionArb,
  setAt,
  successfulRepsArb,
  UTC,
  workoutLabelArb,
  zoneArb,
} from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

const squat: Prescription = {
  exercise: { id: 'squat', name: 'Squat' },
  load: { value: 135, unit: 'lb' },
  sets: 5,
  reps: 5,
}

const toronto = DateTime.zoneUnsafeMakeNamed('America/Toronto')

/** Sets at `squat` starting at each given UTC instant, one minute long, workout A. */
const setsStarting = (...starts: readonly string[]): readonly SetResult[] =>
  starts.map((start) => setAt(squat, 'A', DateTime.unsafeMake(start), 5))

describe('sessionsOf', () => {
  it('should put an evening in Toronto that straddles UTC midnight in one session', () => {
    // 23:30 UTC and 00:30 UTC the next day are 18:30 and 19:30 in Toronto.
    const sets = setsStarting('2026-01-05T23:30:00Z', '2026-01-06T00:30:00Z')
    expect(sessionsOf(sets, toronto).map((session) => session.date)).toEqual(['2026-01-05'])
    expect(sessionsOf(sets, UTC).map((session) => session.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
    ])
  })

  it('should group the sets by their local date, earliest first, keeping every set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(instantArb, workoutLabelArb, fc.nat({ max: 20 }))),
        zoneArb,
        (starts, zone) => {
          // Arrange
          const sets = starts.map(([start, label, reps]) => setAt(squat, label, start, reps))

          // Act
          const sessions = sessionsOf(sets, zone)

          // Assert
          const dates = sessions.map((session) => session.date)
          expect(dates).toEqual(
            [...new Set(sets.map((set) => localDateOf(set.start, zone)))].toSorted()
          )
          for (const session of sessions) {
            expect(session.sets).toEqual(sortByStart(session.sets))
            expect(session.sets.every((set) => localDateOf(set.start, zone) === session.date)).toBe(
              true
            )
            expect(session.workoutLabel).toBe(session.sets[0].workoutLabel)
          }
          expect(sessions.flatMap((session) => session.sets)).toEqual(sortByStart(sets))
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('sessionMet', () => {
  it('should be met by five fives, and not by a fourth set of four', () => {
    const on = (reps: readonly number[]): Session | undefined =>
      sessionsOf(
        reps.map((setReps, index) =>
          setAt(squat, 'A', DateTime.unsafeMake(Date.UTC(2026, 0, 5, 18, index * 3)), setReps)
        ),
        UTC
      )[0]
    const met = on([5, 5, 5, 5, 5])
    const short = on([5, 5, 5, 4, 5])
    if (met === undefined || short === undefined) throw new Error('one session each')
    expect(sessionMet(squat, met)).toBe(true)
    expect(sessionMet(squat, short)).toBe(false)
  })

  it('should be met exactly when every prescribed set reached the prescribed reps', () => {
    fc.assert(
      fc.property(
        prescriptionArb.chain((prescription) =>
          fc.tuple(
            fc.constant(prescription),
            fc.oneof(
              successfulRepsArb(prescription).map((reps) => [true, reps] as const),
              failedRepsArb(prescription).map((reps) => [false, reps] as const)
            )
          )
        ),
        ([prescription, [expected, reps]]) => {
          // Arrange
          const [session] = sessionsOf(
            reps.map((setReps, index) =>
              setAt(
                prescription,
                'A',
                DateTime.unsafeMake(Date.UTC(2026, 0, 5, 18, index * 3)),
                setReps
              )
            ),
            UTC
          )

          // Act / Assert
          if (reps.length === 0) expect(session).toBeUndefined()
          else if (session === undefined) throw new Error('one session')
          else expect(sessionMet(prescription, session)).toBe(expected)
        }
      ),
      { numRuns: RUNS }
    )
  })
})
