import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { ExerciseRequest, PlannedWorkout, StrongLifts5x5 } from 'lifting-core'
import { AUTHORED_ON, made, SUBJECT } from 'lifting-core/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import { FHIR_ID } from './ids.test-helpers.ts'
import { workoutIdMinter } from './workout-id-minter.ts'

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
