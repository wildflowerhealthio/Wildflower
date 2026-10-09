import { cleanup, render, screen, within } from '@testing-library/react'
import { Load, StrongLifts5x5 } from 'lifting-core-js'
import { made } from 'lifting-core-js/test-helpers'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { afterWorkout, startedLifterRecord, submittedOf } from '../lifting.test-helpers.ts'
import { SubmittedWorkoutView } from './submitted-workout-view.tsx'

afterEach(() => {
  cleanup()
})

describe('SubmittedWorkoutView', () => {
  it("should show each exercise's decision, its load moved, and the reps entered", () => {
    const submitted = submittedOf({
      lifterRecord: strongLifts,
      setRepsByExerciseId: { squat: [5, 5, 5, 4, 3], 'bench-press': [5, 5, 5, 5, 5] },
    })

    render(<SubmittedWorkoutView submitted={submitted} />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workout A done')
    expect(rowOf('Squat').textContent).toContain('45 lb · 5/5/5/4/3')
    expect(within(rowOf('Squat')).getByRole('status').textContent).toContain('Hold')
    expect(rowOf('Bench Press').textContent).toContain('45 lb → 50 lb · 5/5/5/5/5')
    expect(within(rowOf('Bench Press')).getByRole('status').textContent).toContain('Increase')
    expect(rowOf('Barbell Row').textContent).toContain('65 lb · No sets entered')
  })

  it('should show a deload once the failures before a deload are reached', () => {
    // Three failed squats at 100 lb, workout A, B and A again.
    const failedSquat = { squat: [5, 5, 5, 5, 0] }
    const twoFailures = afterWorkout({
      lifterRecord: afterWorkout({ lifterRecord: atHundred, setRepsByExerciseId: failedSquat }),
      setRepsByExerciseId: failedSquat,
    })

    render(
      <SubmittedWorkoutView
        submitted={submittedOf({ lifterRecord: twoFailures, setRepsByExerciseId: failedSquat })}
      />
    )

    expect(rowOf('Squat').textContent).toContain('100 lb → 90 lb')
    expect(within(rowOf('Squat')).getByRole('status').textContent).toContain('Deload')
  })
})

// Helpers

const strongLiftsDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')

const strongLifts = startedLifterRecord({
  trainingPlanDefinition: strongLiftsDefinition,
  startingLoads: StrongLifts5x5.STARTING_LOADS,
})

const atHundred = startedLifterRecord({
  trainingPlanDefinition: strongLiftsDefinition,
  startingLoads: {
    ...StrongLifts5x5.STARTING_LOADS,
    squat: made(Load.make({ value: 100, unit: '[lb_av]' })),
  },
})

/** The row of the named exercise. */
const rowOf = (exerciseName: string): HTMLElement => {
  const row = screen.getByText(exerciseName).closest('li')
  if (row === null) throw new Error(`no row for ${exerciseName}`)
  return row
}
