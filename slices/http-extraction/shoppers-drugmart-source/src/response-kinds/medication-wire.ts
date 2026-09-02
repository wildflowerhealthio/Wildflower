import { DIN_CODE_SYSTEM } from '../shoppers.ts'

/** The medication-naming fields a portal payload carries, whatever its shape. */
interface MedicationFields {
  readonly brandName?: string | undefined
  readonly chemicalName?: string | undefined
  readonly din?: string | undefined
}

/**
 * The `medicationCodeableConcept` wire shape shared by the prescription-status
 * `MedicationRequest`/`MedicationDispense` and the history `MedicationDispense`:
 * `text` from the brand (falling back to the chemical) name, plus a DIN coding
 * under {@link DIN_CODE_SYSTEM} when the payload carries one. Returns `undefined`
 * when the payload names no medication at all, so the caller omits the slot
 * entirely.
 *
 * The DIN is **per-payload**: two fills of one prescription can carry different
 * DINs (a brand ↔ generic swap between dispenses), so each entity builds its own
 * coding from its own fields rather than inheriting a prescription-level one.
 */
const medicationWire = (fields: MedicationFields): Record<string, unknown> | undefined => {
  const text = fields.brandName ?? fields.chemicalName
  const coding =
    fields.din != null
      ? [
          {
            system: DIN_CODE_SYSTEM,
            code: fields.din,
            ...(fields.chemicalName != null ? { display: fields.chemicalName } : {}),
          },
        ]
      : []
  if (text == null && coding.length === 0) return undefined
  return {
    ...(coding.length > 0 ? { coding } : {}),
    ...(text != null ? { text } : {}),
  }
}

export { medicationWire, type MedicationFields }
