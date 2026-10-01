import { Option } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { PlannedWorkout } from 'lifting-core'

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

export { submittedWorkoutResources }
