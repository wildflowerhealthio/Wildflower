import { CodeableConcept, WildflowerCodeSystem } from 'fhir-r4/data-types'

/** The {@link WildflowerCodeSystem.Feature} code every lifting resource is filed under. */
const LIFTING_FEATURE_CODE = 'strength-training'

/**
 * The search token (`<system>|<code>`) that finds lifting resources: a
 * `ServiceRequest` search's `category`, a `PlanDefinition` search's `topic`
 * — pass it, unencoded, to a search that URL-encodes its parameters.
 */
const LIFTING_FEATURE_TOKEN = `${WildflowerCodeSystem.Feature}|${LIFTING_FEATURE_CODE}`

/**
 * The `strength-training` feature concept: an exercise `ServiceRequest`'s
 * `category` and a lifting `PlanDefinition`'s `topic`.
 */
const liftingFeatureConcept: CodeableConcept.Type = CodeableConcept.make({
  system: WildflowerCodeSystem.Feature,
  code: LIFTING_FEATURE_CODE,
  display: 'Strength training',
  text: 'Strength training',
})

export { LIFTING_FEATURE_TOKEN, liftingFeatureConcept }
