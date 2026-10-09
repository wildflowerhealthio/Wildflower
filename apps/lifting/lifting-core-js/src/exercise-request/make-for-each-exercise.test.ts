import { Array as Arr, Either, Record as EffectRecord } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ExerciseConcept from '../exercise/exercise-concept.ts'
import * as Load from '../load/load.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  made,
  someOrFail,
  startingLoadsAtFloorOf,
  SUBJECT,
  trainingPlanDefinitionArb,
} from '../test-helpers.ts'
import * as TrainingPlanDefinition from '../training-plan-definition/training-plan-definition.ts'
import * as ExerciseRequest from './exercise-request.ts'

// Each case makes a training plan definition and an `ExerciseRequest` per
// exercise through their schemas, so a property runs fewer iterations than
// one over a single value.
const RUNS = numRunsFor({ base: 30 })

const trainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-1')

/** The id minted for the `ServiceRequest` at `exerciseId`. */
const serviceRequestIdAt = (exerciseId: string): string => `sr-${exerciseId}`

/** StrongLifts started at its template's loads. */
const strongLiftsStarted = (): readonly ExerciseRequest.Type[] =>
  made(
    ExerciseRequest.makeForEachExercise({
      subject: SUBJECT,
      trainingPlanDefinition,
      startingLoads: StrongLifts5x5.STARTING_LOADS,
      mintServiceRequestId: serviceRequestIdAt,
      authoredOn: AUTHORED_ON,
    })
  )

/** The exercise id an `ExerciseRequest` asks for. */
const exerciseIdOf = (exerciseRequest: ExerciseRequest.Type): string =>
  ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest))

describe('ExerciseRequest.makeForEachExercise', () => {
  it("should start StrongLifts with one active ExerciseRequest per lift at the template's loads", () => {
    // Act
    const exerciseRequests = strongLiftsStarted()

    // Assert
    expect(
      exerciseRequests.map((exerciseRequest) => [
        exerciseRequest.id,
        exerciseRequest.status,
        exerciseIdOf(exerciseRequest),
        Load.valueOf(ExerciseRequest.loadOf(exerciseRequest)),
        ExerciseRequest.setsOf(exerciseRequest),
        ExerciseRequest.repsOf(exerciseRequest),
      ])
    ).toEqual([
      ['sr-squat', 'active', 'squat', 45, 5, 5],
      ['sr-bench-press', 'active', 'bench-press', 45, 5, 5],
      ['sr-barbell-row', 'active', 'barbell-row', 65, 5, 5],
      ['sr-overhead-press', 'active', 'overhead-press', 45, 5, 5],
      ['sr-deadlift', 'active', 'deadlift', 95, 1, 5],
    ])
  })

  it('should make one ExerciseRequest per exercise, in the order the training plan definition first runs it, as make makes each', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, (generatedTrainingPlanDefinition) => {
        // Arrange
        const startingLoads = startingLoadsAtFloorOf(generatedTrainingPlanDefinition)

        // Act
        const exerciseRequests = made(
          ExerciseRequest.makeForEachExercise({
            subject: SUBJECT,
            trainingPlanDefinition: generatedTrainingPlanDefinition,
            // A load for an exercise it does not run is passed over.
            startingLoads: {
              ...startingLoads,
              'not-run-0': made(Load.make({ value: 20, unit: 'kg' })),
            },
            mintServiceRequestId: serviceRequestIdAt,
            authoredOn: AUTHORED_ON,
          })
        )

        // Assert
        expect(exerciseRequests).toEqual(
          TrainingPlanDefinition.exercisesOf(generatedTrainingPlanDefinition).map(
            (trainingPlanDefinitionExercise) => {
              const exerciseId = TrainingPlanDefinition.Exercise.exerciseIdOf(
                trainingPlanDefinitionExercise
              )
              return made(
                ExerciseRequest.make({
                  serviceRequestId: serviceRequestIdAt(exerciseId),
                  subject: SUBJECT,
                  trainingPlanDefinition: generatedTrainingPlanDefinition,
                  exerciseId,
                  load: someOrFail(EffectRecord.get(startingLoads, exerciseId)),
                  authoredOn: AUTHORED_ON,
                })
              )
            }
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a training plan definition with exercises without a starting load, naming every one', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionArb.chain((generatedTrainingPlanDefinition) =>
          fc.record({
            generatedTrainingPlanDefinition: fc.constant(generatedTrainingPlanDefinition),
            withoutStartingLoad: fc.subarray(
              TrainingPlanDefinition.exercisesOf(generatedTrainingPlanDefinition).map(
                TrainingPlanDefinition.Exercise.exerciseIdOf
              ),
              { minLength: 1 }
            ),
          })
        ),
        ({ generatedTrainingPlanDefinition, withoutStartingLoad }) => {
          // Act
          const refused = ExerciseRequest.makeForEachExercise({
            subject: SUBJECT,
            trainingPlanDefinition: generatedTrainingPlanDefinition,
            startingLoads: Object.fromEntries(
              Object.entries(startingLoadsAtFloorOf(generatedTrainingPlanDefinition)).filter(
                ([exerciseId]) => !withoutStartingLoad.includes(exerciseId)
              )
            ),
            mintServiceRequestId: serviceRequestIdAt,
            authoredOn: AUTHORED_ON,
          })

          // Assert
          const refusal = someOrFail(Either.getLeft(refused))
          expect(refusal).toBeInstanceOf(ExerciseRequest.ExerciseWithoutStartingLoad)
          expect(refusal).toMatchObject({
            exerciseIds: withoutStartingLoad,
            trainingPlanDefinitionUrl: generatedTrainingPlanDefinition.url,
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it("should refuse a starting load under its rule's floor", () => {
    const refused = ExerciseRequest.makeForEachExercise({
      subject: SUBJECT,
      trainingPlanDefinition,
      startingLoads: {
        ...StrongLifts5x5.STARTING_LOADS,
        squat: made(Load.make({ value: 40, unit: '[lb_av]' })),
      },
      mintServiceRequestId: serviceRequestIdAt,
      authoredOn: AUTHORED_ON,
    })
    expect(
      Either.match(refused, {
        onLeft: (error) => error.message,
        onRight: () => '',
      })
    ).toContain('expected a load of at least 45 [lb_av]')
  })
})

describe('ExerciseRequest.changeTrainingPlanDefinition', () => {
  it('should revoke every active ExerciseRequest, pass over closed ones, and start the new training plan definition', () => {
    // Arrange
    const started = strongLiftsStarted()
    const completedSquat = ExerciseRequest.close(someOrFail(Arr.head(started)), 'completed')
    const others = started.slice(1)
    const otherTrainingPlanDefinition = StrongLifts5x5.trainingPlanDefinition('plan-2')

    // Act
    const change = made(
      ExerciseRequest.changeTrainingPlanDefinition({
        exerciseRequests: [completedSquat, ...others],
        subject: SUBJECT,
        trainingPlanDefinition: otherTrainingPlanDefinition,
        startingLoads: StrongLifts5x5.STARTING_LOADS,
        mintServiceRequestId: (exerciseId) => `plan-2-${exerciseId}`,
        authoredOn: AUTHORED_ON,
      })
    )

    // Assert
    expect(change.revokedExerciseRequests).toEqual(
      others.map((exerciseRequest) => ({ ...exerciseRequest, status: 'revoked' }))
    )
    expect(
      change.startedExerciseRequests.map((exerciseRequest) => [
        exerciseRequest.id,
        ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest),
      ])
    ).toEqual(
      TrainingPlanDefinition.exercisesOf(otherTrainingPlanDefinition).map(
        (trainingPlanDefinitionExercise) => [
          `plan-2-${TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise)}`,
          otherTrainingPlanDefinition.url,
        ]
      )
    )
  })

  it('should revoke nothing when the new training plan definition is refused', () => {
    expect(
      Either.isLeft(
        ExerciseRequest.changeTrainingPlanDefinition({
          exerciseRequests: strongLiftsStarted(),
          subject: SUBJECT,
          trainingPlanDefinition,
          startingLoads: {},
          mintServiceRequestId: serviceRequestIdAt,
          authoredOn: AUTHORED_ON,
        })
      )
    ).toBe(true)
  })
})
