import { DateTime, Either, Record } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it } from 'vite-plus/test'

import type { ExerciseAttempt } from './attempt.ts'
import { type ExerciseGoal, makePlan } from './plan.ts'
import { consecutiveFailures, progressGoal, progressPlan } from './progression.ts'
import {
  attemptAt,
  deloadCaseArb,
  failedRepsArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  planArb,
  progressionCaseArb,
  sessionAt,
  successfulRepsArb,
} from './test-helpers.ts'

const RUNS = numRunsFor({ base: 200 })

describe('progressGoal', () => {
  it('should hold a goal that has never been attempted', () => {
    const goal = squatAt(135)
    expect(progressGoal(goal, [])).toEqual({ decision: 'hold', next: goal })
  })

  it('should add 5 lb after a successful squat session', () => {
    const { decision, next } = progressGoal(squatAt(135), [session(1, 135, [5, 5, 5, 5, 5])])
    expect(decision).toBe('increment')
    expect(next.loadLb).toBe(140)
  })

  it('should hold after one and two failures, and deload 10% after the third', () => {
    // Arrange
    const goal = squatAt(150)
    const failures = [1, 2, 3].map((day) => session(day, 150, [5, 5, 5, 4, 3]))

    // Act
    const afterEach = [1, 2, 3].map((count) => progressGoal(goal, failures.slice(0, count)))

    // Assert
    expect(afterEach.map((progress) => progress.decision)).toEqual(['hold', 'hold', 'deload'])
    // 150 × 0.9 is 134.99999… in floating point; it still lands on 135.
    expect(afterEach[2]?.next.loadLb).toBe(135)
  })

  it('should not deload below the empty bar', () => {
    // 50 × 0.9 = 45; 45 × 0.9 = 40.5 would round to 40, under the 45 lb floor.
    const failuresAt = (loadLb: number): readonly ExerciseAttempt[] =>
      [1, 2, 3].map((day) => session(day, loadLb, [4, 4, 4, 4, 4]))
    expect(progressGoal(squatAt(50), failuresAt(50))).toMatchObject({
      decision: 'deload',
      next: { loadLb: 45 },
    })
    expect(progressGoal(squatAt(45), failuresAt(45)).decision).toBe('hold')
  })

  it('should not count failures at an earlier load toward a deload', () => {
    // Two failures at 140, then a success at 140 moved the goal to 145; one
    // failure at 145 is failure 1 of 3, not 3 of 3.
    const goal = squatAt(145)
    const history = [
      session(1, 140, [5, 5, 4, 4, 4]),
      session(2, 140, [5, 5, 5, 4, 4]),
      session(3, 145, [5, 5, 5, 5, 3]),
    ]
    expect(consecutiveFailures(goal, history)).toBe(1)
    expect(progressGoal(goal, history).decision).toBe('hold')
  })

  it('should make the decision each class of history calls for', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ expected, goal, attempts }) => {
        // Act
        const { decision, next } = progressGoal(goal, attempts)

        // Assert
        expect(decision).toBe(expected)
        if (expected === 'increment') {
          expect(next.loadLb).toBe(goal.loadLb + goal.progression.incrementLb)
        } else if (expected === 'deload') {
          expectDeloadedWithinRule(goal, next.loadLb)
        } else if (expected === 'hold') {
          expect(next).toBe(goal)
        } else {
          assert.fail(`no expectation for ${String(expected satisfies never)}`)
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should never let a deload land below the floor or above the load', () => {
    fc.assert(
      fc.property(deloadCaseArb, ({ goal, attempts }) => {
        const { next } = progressGoal(goal, attempts)
        expect(next.loadLb).toBeGreaterThanOrEqual(goal.progression.minimumLoadLb)
        expect(next.loadLb).toBeLessThan(goal.loadLb)
      }),
      { numRuns: RUNS }
    )
  })

  it('should change nothing but the load', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ goal, attempts }) => {
        const { next } = progressGoal(goal, attempts)
        expect({ ...next, loadLb: goal.loadLb }).toEqual(goal)
      }),
      { numRuns: RUNS }
    )
  })

  it('should hold an already-progressed goal against the same attempts', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ goal, attempts }) => {
        const once = progressGoal(goal, attempts).next
        expect(progressGoal(once, attempts)).toEqual({ decision: 'hold', next: once })
      }),
      { numRuns: RUNS }
    )
  })

  it('should decide the same whatever order the attempts arrive in', () => {
    fc.assert(
      fc.property(
        progressionCaseArb.chain((progressionCase) =>
          fc
            .shuffledSubarray([...progressionCase.attempts], {
              minLength: progressionCase.attempts.length,
            })
            .map((shuffled) => ({ ...progressionCase, shuffled }))
        ),
        ({ goal, attempts, shuffled }) => {
          expect(progressGoal(goal, shuffled)).toEqual(progressGoal(goal, attempts))
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('consecutiveFailures', () => {
  it('should count exactly the failures at the load since the last session at another load', () => {
    fc.assert(
      fc.property(fewFailuresCaseArb, ({ goal, attempts, trailingFailures }) => {
        expect(consecutiveFailures(goal, attempts)).toBe(trailingFailures)
      }),
      { numRuns: RUNS }
    )
  })

  it('should be zero after a success at the load', () => {
    fc.assert(
      fc.property(incrementCaseArb, ({ goal, attempts }) => {
        expect(consecutiveFailures(goal, attempts)).toBe(0)
      }),
      { numRuns: RUNS }
    )
  })

  it('should reach the deload threshold on a deload-class history', () => {
    fc.assert(
      fc.property(deloadCaseArb, ({ goal, attempts }) => {
        expect(consecutiveFailures(goal, attempts)).toBeGreaterThanOrEqual(
          goal.progression.failuresBeforeDeload
        )
      }),
      { numRuns: RUNS }
    )
  })
})

describe('progressPlan', () => {
  it('should keep every plan invariant: makePlan accepts the progressed plan', () => {
    fc.assert(
      fc.property(
        planArb.chain((plan) =>
          fc
            .array(
              fc
                .tuple(fc.constantFrom(...Record.values(plan.goalsByExerciseId)), fc.nat())
                .chain(([goal, index]) =>
                  fc
                    .oneof(successfulRepsArb(goal), failedRepsArb(goal))
                    .map((reps) => attemptAt(goal, sessionAt(index), goal.loadLb, reps))
                )
            )
            .map((attempts) => ({ plan, attempts }))
        ),
        ({ plan, attempts }) => {
          // Act
          const progressed = progressPlan(plan, attempts)

          // Assert
          expect(
            makePlan({
              title: progressed.title,
              goals: Record.values(progressed.goalsByExerciseId),
              workouts: progressed.workouts,
            })
          ).toEqual(Either.right(progressed))
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should progress every goal as progressGoal does, and leave title and workouts alone', () => {
    fc.assert(
      fc.property(
        planArb.chain((plan) =>
          fc
            .array(
              fc
                .tuple(fc.constantFrom(...Record.values(plan.goalsByExerciseId)), fc.nat())
                .chain(([goal, index]) =>
                  successfulRepsArb(goal).map((reps) =>
                    attemptAt(goal, sessionAt(index), goal.loadLb, reps)
                  )
                )
            )
            .map((attempts) => ({ plan, attempts }))
        ),
        ({ plan, attempts }) => {
          const progressed = progressPlan(plan, attempts)
          expect(progressed.title).toBe(plan.title)
          expect(progressed.workouts).toBe(plan.workouts)
          expect(progressed.goalsByExerciseId).toEqual(
            Record.map(plan.goalsByExerciseId, (goal) => progressGoal(goal, attempts).next)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/**
 * A deloaded load obeys the rule's promises, without recomputing it: below the
 * old load, at or above the floor, a step multiple unless it is the floor, and
 * no more than one step under the fraction.
 */
function expectDeloadedWithinRule(goal: ExerciseGoal, deloadedLb: number): void {
  const { deloadFraction, loadStepLb, minimumLoadLb } = goal.progression
  expect(deloadedLb).toBeLessThan(goal.loadLb)
  expect(deloadedLb).toBeGreaterThanOrEqual(minimumLoadLb)
  if (deloadedLb !== minimumLoadLb) {
    const steps = deloadedLb / loadStepLb
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6)
    expect(deloadedLb).toBeLessThanOrEqual(goal.loadLb * (1 - deloadFraction) + 1e-6)
    expect(deloadedLb).toBeGreaterThan(goal.loadLb * (1 - deloadFraction) - loadStepLb - 1e-6)
  }
}

function squatAt(loadLb: number): ExerciseGoal {
  return {
    exercise: { id: 'squat', name: 'Squat' },
    loadLb,
    sets: 5,
    reps: 5,
    progression: {
      incrementLb: 5,
      failuresBeforeDeload: 3,
      deloadFraction: 0.1,
      minimumLoadLb: 45,
      loadStepLb: 5,
    },
  }
}

function session(day: number, loadLb: number, repsCompleted: readonly number[]): ExerciseAttempt {
  return {
    exercise: { id: 'squat', name: 'Squat' },
    workoutLabel: day % 2 === 1 ? 'A' : 'B',
    performedAt: DateTime.unsafeMake(Date.UTC(2026, 0, day, 18)),
    loadLb,
    prescribedSets: 5,
    prescribedReps: 5,
    repsCompleted,
  }
}
