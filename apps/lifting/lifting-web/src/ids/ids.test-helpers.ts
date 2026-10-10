import { ExerciseConcept } from '@wildflowerhealthio/lifting-core-js'
import * as fc from 'fast-check'

/** FHIR R4's `id` grammar. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/

/** An exercise id as `ExerciseConcept.idFromName` makes one: a slug, up to well past the id budget. */
const exerciseIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9]{1,30}(-[a-z0-9]{1,30}){0,3}$/)
  .filter((exerciseId) => ExerciseConcept.idFromName(exerciseId) === exerciseId)

export { exerciseIdArb, FHIR_ID }
