import { Option } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { ExerciseRequest, PlannedWorkout, TrainingPlanDefinition } from 'lifting-core'

/**
 * Everything a submitted workout writes, in one batch: the completed workout
 * `Procedure`, an `Observation` per set, and for each exercise whose load
 * moved its current `ServiceRequest`, closed, and the next one — nothing for
 * a hold, which leaves the current one as it is.
 */
const submittedWorkoutResources = (
  submitted: PlannedWorkout.Submitted
): readonly FhirResource[] => [
  submitted.workoutProcedure,
  ...submitted.exerciseSetObservations,
  ...submitted.exerciseRequestProgresses.flatMap(({ decision, current, next }) =>
    decision === 'hold' ? [] : [current, ...Option.toArray(next)]
  ),
]

/**
 * Everything starting a training plan definition writes, in one batch: the
 * training plan definition itself when it is not stored yet (a template),
 * every `ExerciseRequest` it revokes and every one it starts.
 */
const trainingPlanDefinitionChangeResources = ({
  unstoredTrainingPlanDefinition,
  trainingPlanDefinitionChange,
}: {
  readonly unstoredTrainingPlanDefinition: Option.Option<TrainingPlanDefinition.Type>
  readonly trainingPlanDefinitionChange: ExerciseRequest.TrainingPlanDefinitionChange
}): readonly FhirResource[] => [
  ...Option.toArray(unstoredTrainingPlanDefinition),
  ...trainingPlanDefinitionChange.revokedExerciseRequests,
  ...trainingPlanDefinitionChange.startedExerciseRequests,
]

export { submittedWorkoutResources, trainingPlanDefinitionChangeResources }
