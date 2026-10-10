/**
 * Small FHIR-shaped helpers reused across slices. Does not import the FHIR
 * wire schemas: every export speaks in plain field shapes so a caller can
 * hand it either a decoded resource or its own mirror of the same slot.
 *
 * Today: the supply-duration parser ({@link supplyDurationToParts}), the
 * plain shape it reads ({@link SupplyDuration}), and its UCUM / spelled-out
 * unit tables ({@link UCUM_UNIT} / {@link SPELLED_UNIT}) — pulled out of the
 * medication-calendar slice because a supply duration is a FHIR concept, not
 * a calendar one, and a future consumer that reads
 * `MedicationDispense.daysSupply` needs it too.
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
