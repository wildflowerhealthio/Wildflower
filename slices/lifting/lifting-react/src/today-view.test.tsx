import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTime, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import {
  type ExerciseAttempt,
  type ExerciseGoal,
  goalsFor,
  makePlan,
  STRONGLIFTS_5X5_INPUT,
  strongLifts5x5,
} from 'lifting-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { editablePlanArb } from './test-arbitraries.ts'
import { TodayView, type TodayViewProps } from './today-view.tsx'

afterEach(() => {
  cleanup()
})

describe('TodayView', () => {
  it('should show workout A with its lifts, loads and sets × reps when nothing is logged', () => {
    render(<TodayView {...todayProps()} />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workout A')
    expect(exerciseHeadings()).toEqual(['Squat', 'Bench Press', 'Barbell Row'])
    expect(exerciseCard('Squat').textContent).toContain('45 lb · 5×5')
  })

  it('should show workout B once a workout A session is logged', () => {
    const attempts = sessionOf('A', monday)

    render(<TodayView {...todayProps({ attempts })} />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workout B')
    expect(exerciseHeadings()).toEqual(['Squat', 'Overhead Press', 'Deadlift'])
    expect(exerciseCard('Deadlift').textContent).toContain('95 lb · 1×5')
  })

  it('should start every set button at the prescribed reps', () => {
    render(<TodayView {...todayProps()} />)

    const squatSets = within(setGroup('Squat')).getAllByRole('button')
    expect(squatSets.map((setButton) => setButton.getAttribute('aria-label'))).toEqual([
      'Squat set 1: 5 of 5 reps',
      'Squat set 2: 5 of 5 reps',
      'Squat set 3: 5 of 5 reps',
      'Squat set 4: 5 of 5 reps',
      'Squat set 5: 5 of 5 reps',
    ])
  })

  it('should take a rep off per tap and wrap from 0 back to the prescription', async () => {
    const user = userEvent.setup()
    render(<TodayView {...todayProps()} />)

    const setButton = screen.getByRole('button', { name: 'Squat set 2: 5 of 5 reps' })
    await user.pointer(
      Array.from({ length: 5 }, () => ({ keys: '[MouseLeft]', target: setButton }))
    )
    expect(setButton.getAttribute('aria-label')).toBe('Squat set 2: 0 of 5 reps')
    await user.click(setButton)
    expect(setButton.getAttribute('aria-label')).toBe('Squat set 2: 5 of 5 reps')
  })

  it('should log one attempt per exercise with the reps set on its buttons, stamped now', async () => {
    // Arrange
    const user = userEvent.setup()
    const onLogSession = vi.fn<(sessionAttempts: readonly ExerciseAttempt[]) => void>()
    render(<TodayView {...todayProps({ onLogSession })} />)
    const squatSet2 = screen.getByRole('button', { name: 'Squat set 2: 5 of 5 reps' })
    await user.click(squatSet2)
    await user.click(squatSet2)

    // Act
    await user.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert
    expect(onLogSession).toHaveBeenCalledOnce()
    expect(onLogSession.mock.calls[0]?.[0]).toStrictEqual([
      attemptOf(goal('squat'), 'A', monday, [5, 3, 5, 5, 5]),
      attemptOf(goal('bench-press'), 'A', monday, [5, 5, 5, 5, 5]),
      attemptOf(goal('barbell-row'), 'A', monday, [5, 5, 5, 5, 5]),
    ])
  })

  it('should say how far a lift is from a deload once it has failed at its load', () => {
    const attempts = [
      attemptOf(goal('squat'), 'A', monday, [5, 5, 5, 4, 3]),
      attemptOf(goal('squat'), 'B', wednesday, [5, 5, 5, 5, 4]),
    ]

    render(<TodayView {...todayProps({ attempts })} />)

    expect(exerciseCard('Squat').textContent).toContain('Failed 2 of 3 before a deload')
    expect(exerciseCard('Bench Press').textContent).not.toContain('Failed')
  })

  it('should disable every set button and the log action while a session is saving', () => {
    render(<TodayView {...todayProps({ pending: true })} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(5 + 5 + 5 + 1)
    for (const button of buttons) expect(button).toHaveProperty('disabled', true)
  })

  it('should show a failed save in an alert', () => {
    render(<TodayView {...todayProps({ error: 'The server is unreachable' })} />)

    expect(screen.getByRole('alert').textContent).toContain('The server is unreachable')
  })

  it('should reset the set buttons once the session is added to the attempts', async () => {
    // Arrange: tap a squat set in workout A, then the app records a session.
    const user = userEvent.setup()
    const props = todayProps()
    const { rerender } = render(<TodayView {...props} />)
    await user.click(screen.getByRole('button', { name: 'Squat set 1: 5 of 5 reps' }))

    // Act
    rerender(<TodayView {...props} attempts={sessionOf('A', monday)} />)

    // Assert
    expect(screen.getByRole('button', { name: 'Squat set 1: 5 of 5 reps' })).toBeDefined()
  })

  it("should log the new prescription after the plan changes a lift's sets mid-session", async () => {
    // Arrange: tap a squat set, then the plan is edited to 3 squat sets with
    // no new attempt logged.
    const user = userEvent.setup()
    const onLogSession = vi.fn<(sessionAttempts: readonly ExerciseAttempt[]) => void>()
    const props = todayProps({ onLogSession })
    const { rerender } = render(<TodayView {...props} />)
    await user.click(screen.getByRole('button', { name: 'Squat set 1: 5 of 5 reps' }))
    const threeSetSquatPlan = Either.getOrThrow(
      makePlan({
        ...STRONGLIFTS_5X5_INPUT,
        goals: STRONGLIFTS_5X5_INPUT.goals.map((liftGoal) =>
          liftGoal.exercise.id === 'squat' ? { ...liftGoal, sets: 3 } : liftGoal
        ),
      })
    )

    // Act
    rerender(<TodayView {...props} plan={threeSetSquatPlan} />)
    await user.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert
    const squatAttempt = onLogSession.mock.calls[0]?.[0][0]
    expect(squatAttempt?.prescribedSets).toBe(3)
    expect(squatAttempt?.repsCompleted).toEqual([5, 5, 5])
  })

  it('should list every exercise of the first workout of any plan, in order', () => {
    fc.assert(
      fc.property(editablePlanArb, (plan) => {
        render(<TodayView {...todayProps({ plan })} />)
        try {
          expect(exerciseHeadings()).toEqual(
            goalsFor(plan, plan.workouts[0]).map((planGoal) => planGoal.exercise.name)
          )
        } finally {
          cleanup()
        }
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})

// Helpers

const stronglifts = strongLifts5x5()

const monday = DateTime.unsafeMake('2026-09-21T17:30:00Z')
const wednesday = DateTime.unsafeMake('2026-09-23T17:30:00Z')

/** TodayView props over StrongLifts with nothing logged, stamped Monday, with overrides. */
const todayProps = (overrides: Partial<TodayViewProps> = {}): TodayViewProps => ({
  plan: stronglifts,
  attempts: [],
  now: () => monday,
  onLogSession: () => undefined,
  ...overrides,
})

/** The StrongLifts goal for one lift. */
const goal = (exerciseId: string): ExerciseGoal => {
  const found = stronglifts.goalsByExerciseId[exerciseId]
  if (found === undefined) throw new Error(`no StrongLifts goal ${exerciseId}`)
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

/** A StrongLifts workout logged in full at its prescription. */
const sessionOf = (workoutLabel: string, performedAt: DateTime.Utc): readonly ExerciseAttempt[] =>
  (stronglifts.workouts.find((workout) => workout.label === workoutLabel)?.exerciseIds ?? []).map(
    (exerciseId) => {
      const exerciseGoal = goal(exerciseId)
      return attemptOf(
        exerciseGoal,
        workoutLabel,
        performedAt,
        Array.from({ length: exerciseGoal.sets }, () => exerciseGoal.reps)
      )
    }
  )

/** The exercise names the view lists, in order. */
const exerciseHeadings = (): readonly (string | null)[] =>
  screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

/** The card of the named exercise. */
const exerciseCard = (exerciseName: string): HTMLElement => {
  const card = screen.getByRole('heading', { level: 3, name: exerciseName }).closest('li')
  if (card === null) throw new Error(`no card for ${exerciseName}`)
  return card
}

/** The set buttons' group of the named exercise. */
const setGroup = (exerciseName: string): HTMLElement =>
  screen.getByRole('group', { name: `${exerciseName} sets` })
