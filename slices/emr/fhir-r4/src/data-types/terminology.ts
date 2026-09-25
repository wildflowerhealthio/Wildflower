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
} as const

export { CanadianCodingSystem, WILDFLOWER_EXTENSION_BASE, WildflowerExtension }
