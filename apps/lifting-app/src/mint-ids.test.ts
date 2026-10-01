import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { ExerciseConcept, ExerciseRequest, PlannedWorkout, StrongLifts5x5 } from 'lifting-core'
import { AUTHORED_ON, made, SUBJECT } from 'lifting-core/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import {
  exerciseSetObservationIdOf,
  FHIR_ID_MAX_LENGTH,
  mintResourceId,
  serviceRequestIdMinter,
  workoutIdMinter,
} from './mint-ids.ts'

/** FHIR R4's `id` grammar. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/

/** An exercise id as `ExerciseConcept.idFromName` makes one: a slug, up to well past the id budget. */
const exerciseIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9]{1,30}(-[a-z0-9]{1,30}){0,3}$/)
  .filter((exerciseId) => ExerciseConcept.idFromName(exerciseId) === exerciseId)

/** A set count, from one up to more sets than two digits number. */
const setsArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000 })

describe('exerciseSetObservationIdOf', () => {
  it('should mint a FHIR id for any exercise and set', () => {
    fc.assert(
      fc.property(exerciseIdArb, setsArb, (exerciseId, sets) => {
        for (const setIndex of [0, sets - 1]) {
          expect(
            exerciseSetObservationIdOf({
              procedureId: mintResourceId(),
              exerciseId,
              setIndex,
              sets,
            })
          ).toMatch(FHIR_ID)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it("should sort an exercise's set ids in set order", () => {
    fc.assert(
      fc.property(exerciseIdArb, setsArb, (exerciseId, sets) => {
        const procedureId = mintResourceId()
        const setIds = Array.from({ length: sets }, (_, setIndex) =>
          exerciseSetObservationIdOf({ procedureId, exerciseId, setIndex, sets })
        )
        expect(setIds.toSorted()).toEqual(setIds)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should zero-pad the set index to two digits', () => {
    expect(
      exerciseSetObservationIdOf({
        procedureId: 'workout-1',
        exerciseId: 'squat',
        setIndex: 3,
        sets: 5,
      })
    ).toBe('workout-1-squat-03')
  })

  it('should keep two long exercise ids that share a head apart', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{40}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        (head, leftTail, rightTail) => {
          fc.pre(leftTail !== rightTail)
          const procedureId = mintResourceId()
          const [left, right] = [leftTail, rightTail].map((tail) =>
            exerciseSetObservationIdOf({
              procedureId,
              exerciseId: `${head}-${tail}`,
              setIndex: 0,
              sets: 5,
            })
          )
          expect(left).not.toBe(right)
          expect(left?.length).toBeLessThanOrEqual(FHIR_ID_MAX_LENGTH)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('workoutIdMinter', () => {
  const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('pd-1')
  /** StrongLifts 5×5's first workout, for a lifter who has just started it. */
  const plannedWorkout = made(
    PlannedWorkout.make({
      trainingPlanDefinition,
      exerciseRequests: made(
        ExerciseRequest.makeForEachExercise({
          subject: SUBJECT,
          trainingPlanDefinition,
          startingLoads: StrongLifts5x5.STARTING_LOADS,
          mintServiceRequestId: (exerciseId) => `sr-${exerciseId}`,
          authoredOn: AUTHORED_ON,
        })
      ),
      workoutProcedures: [],
      exerciseSetObservations: [],
    })
  )
  const plannedExerciseIdArb = fc.constantFrom(
    ...plannedWorkout.plannedWorkoutExercises.map(PlannedWorkout.exerciseIdOf)
  )

  /** Every resource one submission of a few exercises and sets can ask an id for. */
  const idsToMintArb: fc.Arbitrary<readonly PlannedWorkout.IdToMint[]> = fc.array(
    fc.oneof(
      fc.constant<PlannedWorkout.IdToMint>({ resourceType: 'Procedure' }),
      fc.record<PlannedWorkout.IdToMint>({
        resourceType: fc.constant('Observation'),
        exerciseId: plannedExerciseIdArb,
        setIndex: fc.integer({ min: 0, max: 9 }),
      }),
      fc.record<PlannedWorkout.IdToMint>({
        resourceType: fc.constant('ServiceRequest'),
        exerciseId: plannedExerciseIdArb,
      })
    ),
    { maxLength: 30 }
  )

  it('should name the same resource with the same id on every call, and different ones apart', () => {
    fc.assert(
      fc.property(idsToMintArb, (idsToMint) => {
        const mintId = workoutIdMinter(plannedWorkout)
        const firstIds = idsToMint.map(mintId)
        // A retry asks again, in any order: every answer is the first one.
        expect(idsToMint.toReversed().map(mintId)).toEqual(firstIds.toReversed())
        const distinctKeys = new Set(idsToMint.map((idToMint) => JSON.stringify(idToMint)))
        expect(new Set(firstIds).size).toBe(distinctKeys.size)
        for (const id of firstIds) expect(id).toMatch(FHIR_ID)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should mint a new workout per submission', () => {
    const procedure: PlannedWorkout.IdToMint = { resourceType: 'Procedure' }
    expect(workoutIdMinter(plannedWorkout)(procedure)).not.toBe(
      workoutIdMinter(plannedWorkout)(procedure)
    )
  })
})

describe('serviceRequestIdMinter', () => {
  it('should name each exercise once, the same on a retry', () => {
    fc.assert(
      fc.property(fc.uniqueArray(exerciseIdArb, { maxLength: 8 }), (exerciseIds) => {
        const mintServiceRequestId = serviceRequestIdMinter()
        const firstIds = exerciseIds.map(mintServiceRequestId)
        expect(exerciseIds.map(mintServiceRequestId)).toEqual(firstIds)
        expect(new Set(firstIds).size).toBe(exerciseIds.length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
