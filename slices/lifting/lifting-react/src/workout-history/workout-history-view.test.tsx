import { cleanup, render, screen, within } from '@testing-library/react'
import { Array as Arr } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { ExerciseRequest, StrongLifts5x5, WorkoutProcedure } from 'lifting-core'
import { progressionCaseArb } from 'lifting-core/test-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { afterWorkout, type LifterRecord, startedLifterRecord } from '../lifting.test-helpers.ts'
import { WorkoutHistoryView } from './workout-history-view.tsx'

beforeEach(() => {
  // Pin a UTC-negative zone so nothing depends on the machine running the
  // suite: America/Los_Angeles is UTC-7 in September, so a workout started
  // at 00:30Z on the 23rd started there on the evening of the 22nd.
  vi.stubEnv('TZ', 'America/Los_Angeles')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('WorkoutHistoryView', () => {
  it('should say so when no workout is completed', () => {
    render(<WorkoutHistoryView {...historyProps(strongLifts)} />)

    expect(screen.getByText(/No workouts yet/)).toBeDefined()
  })

  it('should list each workout newest first, under its day and the local date it started', () => {
    // Workouts start 17:30Z a day apart from Monday 21 September: 10:30 in Los Angeles.
    const lifterRecord = afterWorkout({
      lifterRecord: afterWorkout({ lifterRecord: strongLifts, setRepsByExerciseId: {} }),
      setRepsByExerciseId: {},
    })

    render(<WorkoutHistoryView {...historyProps(lifterRecord)} />)

    expect(workoutHeadings()).toEqual([
      'Workout B · Tue, Sep 22, 2026',
      'Workout A · Mon, Sep 21, 2026',
    ])
  })

  it('should show each exercise with its load, sets × reps and reps per set, badged met, failed or skipped', () => {
    const lifterRecord = afterWorkout({
      lifterRecord: strongLifts,
      setRepsByExerciseId: { squat: [5, 5, 5, 4, 3], 'bench-press': [5, 5, 5, 5, 5] },
    })

    render(<WorkoutHistoryView {...historyProps(lifterRecord)} />)

    expect(rowOf('Squat').textContent).toContain('45 lb · 5×5 · 5/5/5/4/3')
    expect(badgeOf('Squat')).toBe('Error: Failed')
    expect(rowOf('Bench Press').textContent).toContain('45 lb · 5×5 · 5/5/5/5/5')
    expect(badgeOf('Bench Press')).toBe('Success: Met')
    expect(rowOf('Barbell Row').textContent).toContain('No sets logged')
    expect(badgeOf('Barbell Row')).toBe('Skipped')
  })

  it('should name a set by its own exercise, unbadged, when its ExerciseRequest is not passed', () => {
    const lifterRecord = afterWorkout({
      lifterRecord: strongLifts,
      setRepsByExerciseId: { squat: [5, 5, 5, 5, 5] },
    })

    render(<WorkoutHistoryView {...historyProps(lifterRecord)} exerciseRequests={[]} />)

    expect(rowOf('Squat').textContent).toContain('5/5/5/5/5')
    expect(within(rowOf('Squat')).queryByRole('status')).toBeNull()
    expect(screen.queryByText('Bench Press')).toBeNull()
  })

  it('should list every completed workout once, badged as ExerciseRequest.isMetBy judges it', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        render(
          <WorkoutHistoryView
            workoutProcedures={progressionCase.workoutProcedures}
            exerciseSetObservations={progressionCase.exerciseSetObservations}
            exerciseRequests={[progressionCase.exerciseRequest]}
          />
        )
        try {
          const attempts = ExerciseRequest.attemptsAt(
            progressionCase.exerciseRequest,
            progressionCase
          )
          expect(workoutHeadings().length).toBe(
            WorkoutProcedure.completedByStart(progressionCase.workoutProcedures).length
          )
          expect(screen.queryAllByRole('status').map((badge) => badge.textContent?.trim())).toEqual(
            Arr.reverse(attempts).map((attempt) =>
              ExerciseRequest.isMetBy(progressionCase.exerciseRequest, attempt)
                ? 'Success: Met'
                : 'Error: Failed'
            )
          )
        } finally {
          cleanup()
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// Helpers

const strongLifts = startedLifterRecord({
  trainingPlanDefinition: StrongLifts5x5.trainingPlanDefinition('plan-1'),
  startingLoads: StrongLifts5x5.STARTING_LOADS,
})

/** WorkoutHistoryView props for a lifter's record. */
const historyProps = (lifterRecord: LifterRecord): Parameters<typeof WorkoutHistoryView>[0] => ({
  workoutProcedures: lifterRecord.workoutProcedures,
  exerciseSetObservations: lifterRecord.exerciseSetObservations,
  exerciseRequests: lifterRecord.exerciseRequests,
})

/** The workout headings, in order. */
const workoutHeadings = (): readonly (string | null)[] =>
  screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

/** The row of the named exercise; there must be exactly one. */
const rowOf = (exerciseName: string): HTMLElement => {
  const row = screen.getByText(exerciseName).closest('li')
  if (row === null) throw new Error(`no row for ${exerciseName}`)
  return row
}

/** The badge text of the named exercise's row, with its tone's screen-reader prefix. */
const badgeOf = (exerciseName: string): string | undefined =>
  within(rowOf(exerciseName)).getByRole('status').textContent?.trim()
