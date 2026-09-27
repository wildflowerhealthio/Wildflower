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
   * What a strength-training `Goal.target` or `Observation.component`
   * measures: the load in pounds, the prescribed sets and reps, and the reps
   * completed in one set.
   */
  LiftingMeasure: `${WILDFLOWER_CODE_SYSTEM_BASE}/lifting-measure`,
  /**
   * What kind of plan a `CarePlan` is, as its `category` — so a feature's
   * plans can be searched for (`category=<system>|<code>`) apart from every
   * other care plan on the record.
   */
  CarePlanCategory: `${WILDFLOWER_CODE_SYSTEM_BASE}/care-plan-category`,
} as const

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
   * On a strength-training `Goal`: how its load progresses, as a complex
   * extension — no `value[x]` of its own, one nested sub-extension per rule
   * parameter. The sub-extension names are relative to this extension and
   * belong to the feature that writes it.
   */
  LiftingProgression: `${WILDFLOWER_EXTENSION_BASE}/lifting-progression`,
  /**
   * On a strength-training `CarePlan.activity.detail` or `Observation`: the
   * label of the workout (e.g. `"A"`) the exercise is part of, as a
   * `valueString`.
   */
  WorkoutLabel: `${WILDFLOWER_EXTENSION_BASE}/workout-label`,
} as const

export {
  CanadianCodingSystem,
  WILDFLOWER_CODE_SYSTEM_BASE,
  WILDFLOWER_EXTENSION_BASE,
  WildflowerCodeSystem,
  WildflowerExtension,
}
