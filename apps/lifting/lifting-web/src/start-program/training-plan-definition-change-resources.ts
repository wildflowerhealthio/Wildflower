import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { ExerciseRequest, TrainingPlanDefinition } from '@wildflowerhealthio/lifting-core-js'
import { Option } from 'effect'

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

export { trainingPlanDefinitionChangeResources }
