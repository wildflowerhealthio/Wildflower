import { Array as Arr, DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it } from 'vite-plus/test'

import { attemptSucceeded, type ExerciseAttempt, sortByPerformedAt } from './attempt.ts'
import {
  attemptAt,
  failedRepsArb,
  goalArb,
  instantArb,
  successfulRepsArb,
  workoutLabelArb,
} from './test-helpers.ts'

const RUNS = numRunsFor({ base: 200 })

describe('attemptSucceeded', () => {
  it('should count a full 5×5 as a success and a 5-5-5-4-3 as a failure', () => {
    expect(attemptSucceeded(squatWith([5, 5, 5, 5, 5]))).toBe(true)
    expect(attemptSucceeded(squatWith([5, 5, 5, 4, 3]))).toBe(false)
  })

  it('should fail an attempt that stopped a set short, however many reps each set had', () => {
    expect(attemptSucceeded(squatWith([8, 8, 8, 8]))).toBe(false)
  })

  it('should ignore sets past the prescription, short or not', () => {
    expect(attemptSucceeded(squatWith([5, 5, 5, 5, 5, 2]))).toBe(true)
  })

  it('should succeed on a success-class attempt and fail on a too-few-sets or short-set one', () => {
    const attemptCaseArb = goalArb.chain((goal) =>
      fc.oneof(
        successfulRepsArb(goal).map((reps) => ({ kind: 'met' as const, goal, reps })),
        failedRepsArb(goal).map((reps) => ({ kind: 'short' as const, goal, reps }))
      )
    )
    fc.assert(
      fc.property(attemptCaseArb, instantArb, ({ kind, goal, reps }, performedAt) => {
        // Arrange
        const attempt = attemptAt(goal, performedAt, goal.loadLb, reps)

        // Act
        const succeeded = attemptSucceeded(attempt)

        // Assert
        if (kind === 'met') expect(succeeded).toBe(true)
        else if (kind === 'short') expect(succeeded).toBe(false)
        else assert.fail(`no expectation for the ${String(kind satisfies never)} class`)
      }),
      { numRuns: RUNS }
    )
  })

  it('should turn a success into a failure when any one prescribed set is lowered below the reps', () => {
    fc.assert(
      fc.property(goalArb, instantArb, fc.nat(), (goal, performedAt, seed) => {
        // Arrange
        const full = Arr.replicate(goal.reps, goal.sets)
        const lowered = Arr.replace(full, seed % goal.sets, goal.reps - 1)

        // Act / Assert
        expect(attemptSucceeded(attemptAt(goal, performedAt, goal.loadLb, full))).toBe(true)
        expect(attemptSucceeded(attemptAt(goal, performedAt, goal.loadLb, lowered))).toBe(false)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('sortByPerformedAt', () => {
  it('should order attempts oldest first', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(instantArb, workoutLabelArb)), (rows) => {
        const sorted = sortByPerformedAt(rows.map(([at, label]) => squatAt(at, label)))
        for (const [earlier, later] of Arr.zip(sorted, sorted.slice(1))) {
          expect(DateTime.lessThanOrEqualTo(earlier.performedAt, later.performedAt)).toBe(true)
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should keep attempts at the same instant in their input order', () => {
    // Three instants for many attempts, so ties are the common case.
    const instants = [0, 1, 2].map((offset) => DateTime.unsafeMake(Date.UTC(2026, 0, 1 + offset)))
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...instants), { minLength: 2 }), (performedAts) => {
        // Arrange
        const attempts = performedAts.map((at, index) => squatAt(at, `L${index}`))

        // Act
        const sorted = sortByPerformedAt(attempts)

        // Assert
        for (const instant of instants) {
          const tied = (list: readonly ExerciseAttempt[]): readonly ExerciseAttempt[] =>
            list.filter((attempt) => attempt.performedAt === instant)
          expect(tied(sorted)).toEqual(tied(attempts))
        }
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

function squatAt(performedAt: DateTime.Utc, workoutLabel: string): ExerciseAttempt {
  return { ...squatWith([5, 5, 5, 5, 5]), performedAt, workoutLabel }
}

function squatWith(repsCompleted: readonly number[]): ExerciseAttempt {
  return {
    exercise: { id: 'squat', name: 'Squat' },
    workoutLabel: 'A',
    performedAt: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
    loadLb: 135,
    prescribedSets: 5,
    prescribedReps: 5,
    repsCompleted,
  }
}
