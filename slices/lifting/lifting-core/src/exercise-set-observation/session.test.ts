import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseRequest from '../exercise-request/exercise-request.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  instantArb,
  made,
  setAt,
  SUBJECT,
  UTC,
  workoutLabelArb,
  zoneArb,
} from '../test-helpers.ts'
import * as ExerciseSetObservation from './exercise-set-observation.ts'
import * as Session from './session.ts'

const RUNS = numRunsFor({ base: 100 })

const squat = made(
  ExerciseRequest.make({
    serviceRequestId: 'sr-1',
    subject: SUBJECT,
    plan: StrongLifts5x5.plan('plan-1'),
    exerciseId: 'squat',
    load: StrongLifts5x5.STARTING_LOADS.squat,
    authoredOn: AUTHORED_ON,
  })
)

const toronto = DateTime.zoneUnsafeMakeNamed('America/Toronto')

/** Sets at `squat` starting at each given UTC instant, one minute long, workout A. */
const setsStarting = (...starts: readonly string[]): readonly ExerciseSetObservation.Type[] =>
  starts.map((start) =>
    setAt({ exerciseRequest: squat, workoutLabel: 'A', start: DateTime.unsafeMake(start), reps: 5 })
  )

describe('groupByDate', () => {
  it('should put an evening in Toronto that straddles UTC midnight in one session', () => {
    // 23:30 UTC and 00:30 UTC the next day are 18:30 and 19:30 in Toronto.
    const sets = setsStarting('2026-01-05T23:30:00Z', '2026-01-06T00:30:00Z')
    expect(Session.groupByDate(sets, toronto).map((session) => session.date)).toEqual([
      '2026-01-05',
    ])
    expect(Session.groupByDate(sets, UTC).map((session) => session.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
    ])
  })

  it('should group the sets by their local date, earliest first, keeping every set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(instantArb, workoutLabelArb, fc.nat({ max: 20 })), { maxLength: 8 }),
        zoneArb,
        (starts, zone) => {
          // Arrange
          const sets = starts.map(([start, label, reps]) =>
            setAt({ exerciseRequest: squat, workoutLabel: label, start, reps })
          )
          const localDateOf = (set: ExerciseSetObservation.Type): string =>
            Session.localDateOf(ExerciseSetObservation.startOf(set), zone)

          // Act
          const sessions = Session.groupByDate(sets, zone)

          // Assert
          expect(sessions.map((session) => session.date)).toEqual(
            [...new Set(sets.map(localDateOf))].toSorted()
          )
          for (const session of sessions) {
            expect(session.setObservations).toEqual(
              ExerciseSetObservation.sortByStart(session.setObservations)
            )
            expect(session.setObservations.every((set) => localDateOf(set) === session.date)).toBe(
              true
            )
            expect(session.workoutLabel).toBe(
              ExerciseSetObservation.workoutLabelOf(session.setObservations[0])
            )
          }
          expect(sessions.flatMap((session) => session.setObservations)).toEqual(
            ExerciseSetObservation.sortByStart(sets)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})
