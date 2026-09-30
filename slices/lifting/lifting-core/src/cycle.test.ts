import { Array as Arr, DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { exercisesFor, nextWorkout } from './cycle.ts'
import type { Plan, Workout } from './plan.ts'
import type { SetResult } from './set-result.ts'
import { strongLifts5x5 } from './strong-lifts.ts'
import { instantArb, planArb } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

describe('nextWorkout', () => {
  it('should start StrongLifts at A, then alternate B, A, B', () => {
    const plan = strongLifts5x5()
    expect(visitsOf(plan, 4).map((workout) => workout.label)).toEqual(['A', 'B', 'A', 'B'])
  })

  it('should visit every workout in cycle order, then wrap to the first', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const rounds = 2 * plan.workouts.length + 1
        const cycle = plan.workouts.map((workout) => workout.label)
        expect(visitsOf(plan, rounds).map((workout) => workout.label)).toEqual(
          Arr.makeBy(rounds, (index) => cycle[index % cycle.length])
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should follow the most recent set, whatever order the sets arrive in', () => {
    fc.assert(
      fc.property(
        planArb,
        fc.uniqueArray(fc.nat({ max: 1_000_000 }), { minLength: 1 }),
        fc.nat(),
        (plan, offsets, seed) => {
          // Arrange
          const workoutIndexOf = (index: number): number => (seed + index) % plan.workouts.length
          const sets = offsets.map((offset, index) =>
            setIn(
              plan.workouts[workoutIndexOf(index)]?.label ?? '',
              DateTime.unsafeMake(Date.UTC(2026, 0, 1) + offset * 1000)
            )
          )
          const latestWorkoutIndex = workoutIndexOf(offsets.indexOf(Math.max(...offsets)))

          // Act
          const next = nextWorkout(plan, Arr.reverse(sets))

          // Assert
          expect(next).toBe(plan.workouts[(latestWorkoutIndex + 1) % plan.workouts.length])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should start over at the first workout when the latest label is not in the plan', () => {
    fc.assert(
      fc.property(planArb, instantArb, (plan, start) => {
        expect(nextWorkout(plan, [setIn('not-a-workout', start)])).toBe(plan.workouts[0])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('exercisesFor', () => {
  it("should list every one of the workout's exercises as planned, in its order", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        for (const workout of plan.workouts) {
          const planned = exercisesFor(plan, workout)
          expect(planned.map((entry) => entry.exercise.id)).toEqual(workout.exerciseIds)
        }
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

function setIn(workoutLabel: string, start: DateTime.Utc): SetResult {
  return {
    exercise: { id: 'squat', name: 'Squat' },
    workoutLabel,
    start,
    end: DateTime.addDuration(start, '1 minute'),
    reps: 5,
  }
}

/** The workouts `nextWorkout` names over `count` visits, each logged a day after the last. */
function visitsOf(plan: Plan, count: number): readonly Workout[] {
  const sets: SetResult[] = []
  return Arr.makeBy(count, (day) => {
    const workout = nextWorkout(plan, sets)
    sets.push(setIn(workout.label, DateTime.unsafeMake(Date.UTC(2026, 0, day + 1))))
    return workout
  })
}
