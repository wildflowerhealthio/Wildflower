/**
 * How many resources of each lifting type a read found but could not use:
 * entries that did not decode as the FHIR resource, and resources that did
 * but are not the lifting type (`lifting-core-js`'s `Schema` refused them).
 */
interface UnreadableCounts {
  readonly trainingPlanDefinitions: number
  readonly exerciseRequests: number
  readonly workoutProcedures: number
  readonly exerciseSetObservations: number
}

const NO_UNREADABLE: UnreadableCounts = {
  trainingPlanDefinitions: 0,
  exerciseRequests: 0,
  workoutProcedures: 0,
  exerciseSetObservations: 0,
}

export { NO_UNREADABLE, type UnreadableCounts }
