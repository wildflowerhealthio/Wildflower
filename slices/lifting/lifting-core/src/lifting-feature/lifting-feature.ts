import { CodeableConcept, WildflowerCodeSystem } from 'fhir-r4/data-types'

/** The `WildflowerCodeSystem.Feature` code every lifting resource is filed under. */
const CODE = 'strength-training'

/**
 * The search token (`<system>|<code>`) that finds lifting resources: a
 * `ServiceRequest` or `Procedure` search's `category`, a `PlanDefinition`
 * search's `topic` — pass it, unencoded, to a search that URL-encodes its
 * parameters.
 */
const TOKEN = `${WildflowerCodeSystem.Feature}|${CODE}`

/**
 * The `strength-training` feature concept: the `category` of an exercise
 * `ServiceRequest` and of a workout `Procedure`, and the `topic` of a lifting
 * `PlanDefinition`.
 */
const concept: CodeableConcept.Type = CodeableConcept.make({
  system: WildflowerCodeSystem.Feature,
  code: CODE,
  display: 'Strength training',
  text: 'Strength training',
})

export { CODE, concept, TOKEN }
