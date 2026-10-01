/**
 * Canonical coding-system and extension URLs that more than one
 * source maps vendor data onto, defined once here so neither a source nor a
 * reader spells them.
 *
 * @remarks
 * Every value here is part of the persisted wire format: a resource written
 * with one of these URLs is only found again by the same URL. Changing a value
 * orphans already-stored data, so treat this file as append-mostly.
 */

/**
 * Canadian national coding systems, as registered with HL7.
 *
 * @remarks
 * A source keeps its own vendor coding beside the canonical one (additive, not a
 * replacement), so a reader that already knows the vendor system still finds it.
 */
const CanadianCodingSystem = {
  /**
   * Health Canada's Drug Identification Number (DIN) — the 8-digit number
   * every drug product sold in Canada carries on its label. The `NamingSystem`
   * URI HL7 publishes for it.
   */
  Din: 'http://hl7.org/fhir/NamingSystem/ca-hc-din',
} as const

/**
 * Base for every Wildflower-minted extension URL — the same
 * `https://wildflowerhealth.io/fhir/StructureDefinition` namespace
 * `web-trace-core`'s extensions live under. Stable identifiers, not resolvable
 * documents: nothing is served at these URLs today.
 */
const WILDFLOWER_EXTENSION_BASE = 'https://wildflowerhealth.io/fhir/StructureDefinition'

/**
 * Base for every Wildflower-minted code-system URL, beside
 * {@link WILDFLOWER_EXTENSION_BASE}. Stable identifiers, not resolvable
 * documents: nothing is served at these URLs today.
 */
const WILDFLOWER_CODE_SYSTEM_BASE = 'https://wildflowerhealth.io/fhir/CodeSystem'

/**
 * Wildflower-minted code systems, for concepts no published terminology names
 * the way a Wildflower feature needs.
 *
 * @remarks
 * Only the system URLs live here; the codes inside each system belong to the
 * feature that writes them.
 */
const WildflowerCodeSystem = {
  /**
   * Strength-training exercises (`squat`, `bench-press`, …): a stable slug per
   * exercise, with its display name as the coding's `display`.
   */
  Exercise: `${WILDFLOWER_CODE_SYSTEM_BASE}/exercise`,
  /**
   * Which parameter of an exercise a strength-training
   * `ServiceRequest.orderDetail` or `PlanDefinition.action.code` concept
   * gives: the load, the sets, the reps. Each such concept carries its value
   * in a {@link WildflowerExtension.ExerciseParameterValue} extension.
   */
  ExerciseParameter: `${WILDFLOWER_CODE_SYSTEM_BASE}/exercise-parameter`,
  /**
   * Which Wildflower feature a resource belongs to (`strength-training`), as
   * a `ServiceRequest.category`, a `Procedure.category` or a
   * `PlanDefinition.topic` — so a feature's resources can be searched for
   * (`category=<system>|<code>`, `topic=<system>|<code>`) apart from every
   * other on the record.
   */
  Feature: `${WILDFLOWER_CODE_SYSTEM_BASE}/feature`,
  /**
   * Which workout of a strength-training plan a `Procedure` is, as its
   * `code`: the workout's label within the plan (`A`, `B`) as the code and the
   * display. A label names a workout only within one plan, so the plan is the
   * `Procedure.instantiatesCanonical` beside it.
   */
  Workout: `${WILDFLOWER_CODE_SYSTEM_BASE}/workout`,
} as const

/**
 * Base for every canonical url a Wildflower-minted definitional resource
 * (`PlanDefinition.url`) carries, and that an instance names in
 * `instantiatesCanonical`. Stable identifiers, not resolvable documents.
 */
const WILDFLOWER_CANONICAL_BASE = 'https://wildflowerhealth.io/fhir'

/** Wildflower-minted extension URLs for values R4 has no conventional slot for. */
const WildflowerExtension = {
  /**
   * On `MedicationRequest.dispenseRequest`: the repeats (refills) still
   * available, as a `valueInteger`. R4 carries only the total
   * `numberOfRepeatsAllowed`, not how many remain.
   */
  RepeatsAvailable: `${WILDFLOWER_EXTENSION_BASE}/repeats-available`,
  /**
   * On a `Medication`: a human-readable description of the drug product,
   * richer than `code.text` (e.g. `"20 mg - Tablet"`), as a `valueString`. Its
   * natural home is the narrative; it rides this extension only when the
   * narrative already holds other content that must not be overwritten.
   */
  MedicationDescription: `${WILDFLOWER_EXTENSION_BASE}/medication-description`,
  /**
   * On a strength-training `PlanDefinition.action` for one exercise: how its
   * load progresses, as a complex extension — no `value[x]` of its own, one
   * nested sub-extension per rule parameter. The sub-extension names are
   * relative to this extension and belong to the feature that writes it.
   */
  LiftingProgression: `${WILDFLOWER_EXTENSION_BASE}/lifting-progression`,
  /**
   * On a `CodeableConcept` coded in
   * {@link WildflowerCodeSystem.ExerciseParameter} — a
   * `ServiceRequest.orderDetail` or `PlanDefinition.action.code` entry: the
   * exercise parameter's value, a `valueQuantity` for a load and a
   * `valueInteger` for sets or reps.
   */
  ExerciseParameterValue: `${WILDFLOWER_EXTENSION_BASE}/exercise-parameter-value`,
} as const

export {
  CanadianCodingSystem,
  WILDFLOWER_CANONICAL_BASE,
  WILDFLOWER_CODE_SYSTEM_BASE,
  WILDFLOWER_EXTENSION_BASE,
  WildflowerCodeSystem,
  WildflowerExtension,
}
