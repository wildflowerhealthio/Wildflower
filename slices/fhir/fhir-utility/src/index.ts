/**
 * Small FHIR-shaped helpers reused across slices. Does not import the FHIR
 * wire schemas: every export speaks in plain field shapes so a caller can
 * hand it either a decoded resource or its own mirror of the same slot.
 *
 * Today: the supply-duration parser ({@link supplyDurationToParts}), the
 * plain shape it reads ({@link SupplyDuration}), and its UCUM / spelled-out
 * unit tables ({@link UCUM_UNIT} / {@link SPELLED_UNIT}). A supply duration
 * is a FHIR concept, not a calendar one, so it lives here for every slice
 * that reads `MedicationRequest.dispenseRequest.expectedSupplyDuration` or
 * `MedicationDispense.daysSupply`.
 *
 * @packageDocumentation
 */

export {
  type PartBuilder,
  SPELLED_UNIT,
  type SupplyDuration,
  supplyDurationToParts,
  UCUM_UNIT,
} from './supply-duration.ts'
