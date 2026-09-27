import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Array as Arr, DateTime, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import {
  type ExerciseAttempt,
  type ExerciseGoal,
  goalsFor,
  type Plan,
  progressGoal,
  progressPlan,
  makePlan,
  STRONGLIFTS_5X5_INPUT,
  strongLifts5x5,
} from 'lifting-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ProgressionReview, type ProgressionReviewProps } from './progression-review.tsx'
import { editablePlanArb } from './test-arbitraries.ts'

afterEach(() => {
  cleanup()
})

describe('ProgressionReview', () => {
  it('should show each lift trained successfully going up, and the rest holding', () => {
    const attempts = fullSession(stronglifts, 'A')

    render(<ProgressionReview {...reviewProps({ attempts })} />)

    expect(goalRow('Squat').textContent).toContain('45 lb → 50 lb')
    expect(badgeOf('Squat')).toContain('Increase')
    expect(badgeOf('Bench Press')).toContain('Increase')
    expect(badgeOf('Barbell Row')).toContain('Increase')
    expect(badgeOf('Overhead Press')).toContain('Hold')
    expect(badgeOf('Deadlift')).toContain('Hold')
  })

  it('should show a deload, old load to new, after the last allowed failure', () => {
    // Arrange: three failed squat sessions at 100 lb.
    const plan = Either.getOrThrow(
      makePlan({
        ...STRONGLIFTS_5X5_INPUT,
        goals: STRONGLIFTS_5X5_INPUT.goals.map((liftGoal) =>
          liftGoal.exercise.id === 'squat' ? { ...liftGoal, loadLb: 100 } : liftGoal
        ),
      })
    )
    const squat = goalOf(plan, 'squat')
    const attempts = [monday, wednesday, friday].map((performedAt) =>
      attemptOf(squat, 'A', performedAt, [5, 5, 5, 5, 4])
    )

    // Act
    render(<ProgressionReview {...reviewProps({ plan, attempts })} />)

    // Assert
    expect(badgeOf('Squat')).toContain('Deload')
    expect(goalRow('Squat').textContent).toContain(
      `100 lb → ${progressGoal(squat, attempts).next.loadLb} lb`
    )
  })

  it('should note how far a held lift is from a deload', () => {
    const squat = goalOf(stronglifts, 'squat')
    const attempts = [attemptOf(squat, 'A', monday, [5, 5, 5, 5, 4])]

    render(<ProgressionReview {...reviewProps({ attempts })} />)

    expect(goalRow('Squat').textContent).toContain('45 lb · failed 1 of 3')
  })

  it('should hand onAccept exactly the plan progressPlan returns', async () => {
    // Arrange
    const user = userEvent.setup()
    const onAccept = vi.fn<(progressedPlan: Plan) => void>()
    const attempts = fullSession(stronglifts, 'A')
    render(<ProgressionReview {...reviewProps({ attempts, onAccept })} />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Apply progression' }))

    // Assert
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onAccept.mock.calls[0]?.[0]).toStrictEqual(progressPlan(stronglifts, attempts))
  })

  it('should offer nothing to apply when every load holds', () => {
    render(<ProgressionReview {...reviewProps()} />)

    expect(screen.queryByRole('button', { name: 'Apply progression' })).toBeNull()
    expect(screen.getByText('Every load holds — there is nothing to apply.')).toBeDefined()
  })

  it('should disable the action while the progressed plan is saving', () => {
    render(
      <ProgressionReview
        {...reviewProps({ attempts: fullSession(stronglifts, 'A'), pending: true })}
      />
    )

    expect(screen.getByRole('button', { name: 'Applying…' })).toHaveProperty('disabled', true)
  })

  it('should show a failed save in an alert', () => {
    render(<ProgressionReview {...reviewProps({ error: 'Conflict: the plan changed' })} />)

    expect(screen.getByRole('alert').textContent).toContain('Conflict: the plan changed')
  })

  it("should badge every goal of any plan with progressGoal's decision", () => {
    fc.assert(
      fc.property(
        editablePlanArb.chain((plan) => fc.tuple(fc.constant(plan), sessionArb(plan))),
        ([plan, attempts]) => {
          render(<ProgressionReview {...reviewProps({ plan, attempts })} />)
          try {
            for (const planGoal of Object.values(plan.goalsByExerciseId)) {
              expect(badgeOf(planGoal.exercise.name)).toContain(
                decisionLabels[progressGoal(planGoal, attempts).decision]
              )
            }
          } finally {
            cleanup()
          }
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})

// Helpers

const stronglifts = strongLifts5x5()

const monday = DateTime.unsafeMake('2026-09-21T17:30:00Z')
const wednesday = DateTime.unsafeMake('2026-09-23T17:30:00Z')
const friday = DateTime.unsafeMake('2026-09-25T17:30:00Z')

/** The badge text each decision reads as. */
const decisionLabels = { increment: 'Increase', hold: 'Hold', deload: 'Deload' } as const

/** ProgressionReview props over StrongLifts with nothing logged, with overrides. */
const reviewProps = (overrides: Partial<ProgressionReviewProps> = {}): ProgressionReviewProps => ({
  plan: stronglifts,
  attempts: [],
  onAccept: () => undefined,
  ...overrides,
})

/** The plan's goal for one exercise. */
const goalOf = (plan: Plan, exerciseId: string): ExerciseGoal => {
  const found = plan.goalsByExerciseId[exerciseId]
  if (found === undefined) throw new Error(`no goal ${exerciseId}`)
  return found
}

/** An attempt at the goal's prescription with the given reps. */
const attemptOf = (
  exerciseGoal: ExerciseGoal,
  workoutLabel: string,
  performedAt: DateTime.Utc,
  repsCompleted: readonly number[]
): ExerciseAttempt => ({
  exercise: exerciseGoal.exercise,
  workoutLabel,
  performedAt,
  loadLb: exerciseGoal.loadLb,
  prescribedSets: exerciseGoal.sets,
  prescribedReps: exerciseGoal.reps,
  repsCompleted,
})

/** A workout of the plan logged Monday, every set at its prescription. */
const fullSession = (plan: Plan, workoutLabel: string): readonly ExerciseAttempt[] =>
  plan.workouts
    .filter((workout) => workout.label === workoutLabel)
    .flatMap((workout) => goalsFor(plan, workout))
    .map((exerciseGoal) =>
      attemptOf(
        exerciseGoal,
        workoutLabel,
        monday,
        Arr.replicate(exerciseGoal.reps, exerciseGoal.sets)
      )
    )

/** A session of the plan's first workout on Monday, each set anywhere from 0 to its prescription. */
const sessionArb = (plan: Plan): fc.Arbitrary<readonly ExerciseAttempt[]> => {
  const firstWorkout = Arr.headNonEmpty(plan.workouts)
  return fc.tuple(
    ...goalsFor(plan, firstWorkout).map((exerciseGoal) =>
      fc
        .array(fc.integer({ min: 0, max: exerciseGoal.reps }), {
          minLength: exerciseGoal.sets,
          maxLength: exerciseGoal.sets,
        })
        .map((repsCompleted) => attemptOf(exerciseGoal, firstWorkout.label, monday, repsCompleted))
    )
  )
}

/** The list row of the named exercise. */
const goalRow = (exerciseName: string): HTMLElement => {
  const row = screen.getByText(exerciseName, { selector: 'span.text-body-2' }).closest('li')
  if (row === null) throw new Error(`no row for ${exerciseName}`)
  return row
}

/** The decision badge's text on the named exercise's row. */
const badgeOf = (exerciseName: string): string =>
  within(goalRow(exerciseName)).getByRole('status').textContent ?? ''
