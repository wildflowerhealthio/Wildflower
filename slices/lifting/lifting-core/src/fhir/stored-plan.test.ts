import { Array as Arr, DateTime, Either, Option, Record } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Plan } from '../plan.ts'
import { strongLifts5x5 } from '../strong-lifts.ts'
import { instantArb, planArb } from '../test-helpers.ts'
import { exerciseGoalFromFhir } from './goal.ts'
import type { StoredPlan } from './plan.ts'
import { currentPlanOf, progressionGoalsToFhir } from './stored-plan.ts'

const RUNS = numRunsFor({ base: 100 })

/** Stored plans told apart by id, each with or without a `created`. */
const storedPlansArb: fc.Arbitrary<readonly StoredPlan[]> = fc
  .array(fc.option(instantArb, { nil: undefined }), { maxLength: 8 })
  .map((createdTimes) =>
    createdTimes.map((created, index) => ({
      plan: strongLifts5x5(),
      carePlanId: `plan-${index}`,
      goalIdByExerciseId: {},
      created: Option.fromNullable(created),
    }))
  )

/** A stored plan's `created`, as epoch millis or `null`, for comparing by value. */
const createdMillisOf = (stored: StoredPlan): number | null =>
  Option.getOrNull(Option.map(stored.created, DateTime.toEpochMillis))

describe('currentPlanOf', () => {
  it('should follow the plan created most recently, however the plans were read', () => {
    fc.assert(
      fc.property(storedPlansArb, (storedPlans) => {
        // Act
        const { current } = currentPlanOf(storedPlans)

        // Assert
        const dated = Arr.filterMap(storedPlans, (stored) =>
          Option.map(stored.created, DateTime.toEpochMillis)
        )
        const newest = dated.length === 0 ? null : Math.max(...dated)
        expect(Option.map(current, createdMillisOf)).toEqual(
          storedPlans.length === 0 ? Option.none() : Option.some(newest)
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should rank every plan with no created after every dated one', () => {
    fc.assert(
      fc.property(storedPlansArb, (storedPlans) => {
        // Act
        const { current, others } = currentPlanOf(storedPlans)

        // Assert
        const ranked = [...Option.toArray(current), ...others].map(createdMillisOf)
        const firstUndated = ranked.indexOf(null)
        expect(
          firstUndated === -1 || ranked.slice(firstUndated).every((millis) => millis === null)
        ).toBe(true)
        expect(ranked).toHaveLength(storedPlans.length)
      }),
      { numRuns: RUNS }
    )
  })

  it('should keep the input order between plans that tie', () => {
    fc.assert(
      fc.property(
        fc.option(instantArb, { nil: undefined }),
        fc.integer({ min: 2, max: 6 }),
        (created, count) => {
          // Arrange — every plan created at the same time, or none of them dated
          const storedPlans = Arr.makeBy(count, (index) => ({
            plan: strongLifts5x5(),
            carePlanId: `plan-${index}`,
            goalIdByExerciseId: {},
            created: Option.fromNullable(created),
          }))

          // Act
          const { current, others } = currentPlanOf(storedPlans)

          // Assert
          expect(
            [...Option.toArray(current), ...others].map((stored) => stored.carePlanId)
          ).toEqual(storedPlans.map((stored) => stored.carePlanId))
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('progressionGoalsToFhir', () => {
  it('should write exactly the goals whose load moved, each under its stored id', () => {
    fc.assert(
      fc.property(planArb, fc.array(fc.boolean()), (plan, moves) => {
        // Arrange — move the load of some goals, keep the rest
        const stored = storedFor(plan)
        const exerciseIds = Record.keys(plan.goalsByExerciseId)
        const movedIds = exerciseIds.filter((_, index) => moves[index])
        const progressed = withLoadsMoved(plan, movedIds)

        // Act
        const written = progressionGoalsToFhir(stored, progressed, 'Patient/p-1')

        // Assert
        expect(
          Either.map(written, (goals) =>
            goals.map((goal) => [
              goal.id,
              Either.getOrNull(Either.map(exerciseGoalFromFhir(goal), (read) => read.loadLb)),
            ])
          )
        ).toEqual(
          Either.right(
            movedIds.map((exerciseId) => [
              `goal-${exerciseId}`,
              progressed.goalsByExerciseId[exerciseId]?.loadLb,
            ])
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a moved goal the stored plan has no id for, rather than skip it', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        // Arrange — every goal moves, and the first has lost its stored id
        const exerciseIds = Record.keys(plan.goalsByExerciseId)
        const [forgotten] = exerciseIds
        fc.pre(forgotten !== undefined)
        const stored = storedFor(plan)
        const partlyStored = {
          ...stored,
          goalIdByExerciseId: Record.remove(stored.goalIdByExerciseId, forgotten),
        }

        // Act
        const written = progressionGoalsToFhir(
          partlyStored,
          withLoadsMoved(plan, exerciseIds),
          'Patient/p-1'
        )

        // Assert
        expect(Either.map(Either.flip(written), (missing) => missing.exerciseIds)).toEqual(
          Either.right([forgotten])
        )
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** `plan` stored under `goal-<exerciseId>` ids. */
const storedFor = (plan: Plan): StoredPlan => ({
  plan,
  carePlanId: 'plan-1',
  goalIdByExerciseId: Record.map(
    plan.goalsByExerciseId,
    (_goal, exerciseId) => `goal-${exerciseId}`
  ),
  created: Option.none(),
})

/** `plan` with the load of each named exercise's goal raised by its increment. */
const withLoadsMoved = (plan: Plan, exerciseIds: readonly string[]): Plan => ({
  ...plan,
  goalsByExerciseId: Record.map(plan.goalsByExerciseId, (goal, exerciseId) =>
    exerciseIds.includes(exerciseId)
      ? { ...goal, loadLb: goal.loadLb + goal.progression.incrementLb }
      : goal
  ),
})
