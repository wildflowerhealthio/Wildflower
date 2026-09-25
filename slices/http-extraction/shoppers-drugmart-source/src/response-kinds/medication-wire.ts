import { CanadianCodingSystem } from 'fhir-r4/data-types'

/** The medication-naming fields a portal payload carries, whatever its shape. */
interface MedicationFields {
  readonly brandName?: string | undefined
  readonly chemicalName?: string | undefined
  readonly din?: string | undefined
}

/**
 * The `medicationCodeableConcept` wire shape shared by the prescription-status
 * `MedicationRequest`/`MedicationDispense` and the history `MedicationDispense`:
 * `text` from the brand (falling back to the chemical) name, plus — when the
 * payload carries a DIN — a single coding under `fhir-r4`'s canonical
 * `CanadianCodingSystem.Din`. The portal has no DIN system of its own, so no
 * vendor coding is minted beside it. Returns `undefined`
 * when the payload names no medication at all, so the caller omits the slot
 * entirely.
 *
 * The DIN is **per-payload**: two fills of one prescription can carry different
 * DINs (a brand ↔ generic swap between dispenses), so each entity builds its own
 * coding from its own fields rather than inheriting a prescription-level one.
 */
const medicationWire = (fields: MedicationFields): Record<string, unknown> | undefined => {
  const text = fields.brandName ?? fields.chemicalName
  const display = fields.chemicalName != null ? { display: fields.chemicalName } : {}
  const din = fields.din
  const coding = din != null ? [{ system: CanadianCodingSystem.Din, code: din, ...display }] : []
  if (text == null && coding.length === 0) return undefined
  return {
    ...(coding.length > 0 ? { coding } : {}),
    ...(text != null ? { text } : {}),
  }
}

export { medicationWire, type MedicationFields }
