import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Array as Arr, DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import {
  ExerciseConcept,
  PlannedWorkout,
  StrongLifts5x5,
  TrainingPlanDefinition,
} from 'lifting-core'
import {
  made,
  startingLoadsAtFloorOf,
  SUBJECT,
  trainingPlanDefinitionArb,
} from 'lifting-core/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { afterWorkout, plannedWorkoutOf, startedLifterRecord } from '../lifting.test-helpers.ts'
import {
  PlannedWorkoutView,
  type PlannedWorkoutViewProps,
  type WorkoutSubmission,
} from './planned-workout-view.tsx'

afterEach(() => {
  cleanup()
})

describe('PlannedWorkoutView', () => {
  it('should show workout A with its lifts, loads and sets × reps when nothing is done yet', () => {
    render(<PlannedWorkoutView {...plannedWorkoutProps()} />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workout A')
    expect(exerciseHeadings()).toEqual(['Squat', 'Bench Press', 'Barbell Row'])
    expect(exerciseCard('Barbell Row').textContent).toContain('65 lb · 5×5')
  })

  it('should show workout B once workout A is done', () => {
    const lifterRecord = afterWorkout({ lifterRecord: strongLifts, setRepsByExerciseId: {} })

    render(
      <PlannedWorkoutView
        {...plannedWorkoutProps({ plannedWorkout: plannedWorkoutOf(lifterRecord) })}
      />
    )

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workout B')
    expect(exerciseHeadings()).toEqual(['Squat', 'Overhead Press', 'Deadlift'])
    expect(exerciseCard('Deadlift').textContent).toContain('95 lb · 1×5')
  })

  it('should start every set not done, and submit nothing until a set is entered', () => {
    render(<PlannedWorkoutView {...plannedWorkoutProps()} />)

    expect(
      within(setGroup('Squat'))
        .getAllByRole('button')
        .map((setButton) => setButton.getAttribute('aria-label'))
    ).toEqual([
      'Squat set 1: not done',
      'Squat set 2: not done',
      'Squat set 3: not done',
      'Squat set 4: not done',
      'Squat set 5: not done',
    ])
    expect(submitButton()).toHaveProperty('disabled', true)
  })

  it('should enter the reps asked for, take one off per tap, and make a set not done after 0', async () => {
    const user = userEvent.setup()
    render(<PlannedWorkoutView {...plannedWorkoutProps()} />)
    const setButton = screen.getByRole('button', { name: 'Squat set 2: not done' })

    await user.click(setButton)
    expect(setButton.getAttribute('aria-label')).toBe('Squat set 2: 5 of 5 reps')
    await user.pointer(
      Array.from({ length: 5 }, () => ({ keys: '[MouseLeft]', target: setButton }))
    )
    expect(setButton.getAttribute('aria-label')).toBe('Squat set 2: 0 of 5 reps')
    await user.click(setButton)
    expect(setButton.getAttribute('aria-label')).toBe('Squat set 2: not done')
  })

  it('should submit the sets entered per exercise with the span from the first set to submitting', async () => {
    // Arrange: the clock reads the first set's time, then the submit's.
    const user = userEvent.setup()
    const onSubmit = vi.fn<(workoutSubmission: WorkoutSubmission) => void>()
    const now = vi
      .fn<() => DateTime.Utc>()
      .mockReturnValueOnce(firstSetAt)
      .mockReturnValueOnce(submittedAt)
    render(<PlannedWorkoutView {...plannedWorkoutProps({ onSubmit, now })} />)
    await tapEachSet('Squat', [1, 1, 1, 3, 1])
    await tapEachSet('Bench Press', [1, 1])

    // Act
    await user.click(submitButton())

    // Assert: the squat's fourth set is 3 reps, the bench press stops at two
    // sets, and the barbell row, with none entered, is left out.
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0]).toStrictEqual({
      setRepsByExerciseId: { squat: [5, 5, 5, 3, 5], 'bench-press': [5, 5] },
      start: firstSetAt,
      end: submittedAt,
    })
  })

  it('should say how far a lift is from a deload once it has failed at its load', () => {
    const lifterRecord = afterWorkout({
      lifterRecord: afterWorkout({
        lifterRecord: strongLifts,
        setRepsByExerciseId: { squat: [5, 5, 5, 4, 3], 'bench-press': [5, 5, 5, 5, 5] },
      }),
      setRepsByExerciseId: { squat: [5, 5, 5, 5, 4] },
    })

    render(
      <PlannedWorkoutView
        {...plannedWorkoutProps({ plannedWorkout: plannedWorkoutOf(lifterRecord) })}
      />
    )

    expect(exerciseCard('Squat').textContent).toContain('Failure 2 of 3 before a deload')
    expect(exerciseCard('Bench Press').textContent).toContain('50 lb · 5×5')
    expect(exerciseCard('Bench Press').textContent).not.toContain('Failure')
  })

  it('should disable every set button and the submit action while the workout is written', async () => {
    const user = userEvent.setup()
    const props = plannedWorkoutProps()
    const { rerender } = render(<PlannedWorkoutView {...props} />)
    await user.click(screen.getByRole('button', { name: 'Squat set 1: not done' }))

    rerender(<PlannedWorkoutView {...props} pending />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(5 + 5 + 5 + 1)
    for (const button of buttons) expect(button).toHaveProperty('disabled', true)
  })

  it('should show a failed write in an alert', () => {
    render(<PlannedWorkoutView {...plannedWorkoutProps({ error: 'The server is unreachable' })} />)

    expect(screen.getByRole('alert').textContent).toContain('The server is unreachable')
  })

  it('should start over with nothing entered once another workout is planned', async () => {
    const user = userEvent.setup()
    const props = plannedWorkoutProps()
    const { rerender } = render(<PlannedWorkoutView {...props} />)
    await user.click(screen.getByRole('button', { name: 'Squat set 1: not done' }))

    rerender(
      <PlannedWorkoutView
        {...props}
        plannedWorkout={plannedWorkoutOf(
          afterWorkout({ lifterRecord: strongLifts, setRepsByExerciseId: { squat: [5] } })
        )}
      />
    )

    expect(screen.getByRole('button', { name: 'Squat set 1: not done' })).toBeDefined()
  })

  it("should submit what PlannedWorkout.submit takes, every lift met, for any plan's first workout", async () => {
    await fc.assert(
      fc.asyncProperty(trainingPlanDefinitionArb, async (trainingPlanDefinition) => {
        const user = userEvent.setup()
        const plannedWorkout = plannedWorkoutOf(
          startedLifterRecord({
            trainingPlanDefinition,
            startingLoads: startingLoadsAtFloorOf(trainingPlanDefinition),
          })
        )
        const onSubmit = vi.fn<(workoutSubmission: WorkoutSubmission) => void>()
        render(<PlannedWorkoutView {...plannedWorkoutProps({ plannedWorkout, onSubmit })} />)
        try {
          // Act: one tap per set enters the reps asked for.
          await user.pointer(
            plannedWorkout.plannedWorkoutExercises.flatMap((plannedWorkoutExercise) =>
              within(setGroup(nameOf(plannedWorkoutExercise)))
                .getAllByRole('button')
                .map((target) => ({ keys: '[MouseLeft]', target }))
            )
          )
          await user.click(submitButton())

          // Assert
          expect(exerciseHeadings()).toEqual(plannedWorkout.plannedWorkoutExercises.map(nameOf))
          const workoutSubmission = onSubmit.mock.calls[0]?.[0]
          if (workoutSubmission === undefined) throw new Error('nothing submitted')
          const submitted = made(
            PlannedWorkout.submit({
              ...workoutSubmission,
              plannedWorkout,
              subject: SUBJECT,
              mintId: (idToMint) => JSON.stringify(idToMint),
            })
          )
          expect(submitted.exerciseRequestProgresses.map(({ decision }) => decision)).toEqual(
            Arr.map(plannedWorkout.plannedWorkoutExercises, () => 'increment')
          )
        } finally {
          cleanup()
        }
      }),
      { numRuns: numRunsFor({ base: 15 }) }
    )
  })
})

// Helpers

const strongLifts = startedLifterRecord({
  trainingPlanDefinition: StrongLifts5x5.trainingPlanDefinition('plan-1'),
  startingLoads: StrongLifts5x5.STARTING_LOADS,
})

const firstSetAt = DateTime.unsafeMake('2026-09-21T17:30:00Z')
const submittedAt = DateTime.unsafeMake('2026-09-21T18:20:00Z')

/** PlannedWorkoutView props for StrongLifts' first workout, the clock at `firstSetAt`, with overrides. */
const plannedWorkoutProps = (
  overrides: Partial<PlannedWorkoutViewProps> = {}
): PlannedWorkoutViewProps => ({
  plannedWorkout: plannedWorkoutOf(strongLifts),
  now: () => firstSetAt,
  onSubmit: () => undefined,
  ...overrides,
})

/** A planned exercise's name. */
const nameOf = (plannedWorkoutExercise: PlannedWorkout.Exercise): string =>
  ExerciseConcept.nameOf(
    TrainingPlanDefinition.Exercise.exerciseConceptOf(
      plannedWorkoutExercise.trainingPlanDefinitionExercise
    )
  )

/** Taps the named exercise's sets in order, the Nth `taps[N]` times. */
const tapEachSet = async (exerciseName: string, taps: readonly number[]): Promise<void> => {
  const setButtons = within(setGroup(exerciseName)).getAllByRole('button')
  await userEvent.setup().pointer(
    taps.flatMap((tapCount, setIndex) =>
      Array.from({ length: tapCount }, () => ({
        keys: '[MouseLeft]',
        target: setButtons[setIndex] ?? document.body,
      }))
    )
  )
}

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

/** The submit action. */
const submitButton = (): HTMLElement => screen.getByRole('button', { name: 'Submit workout' })
