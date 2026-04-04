import { Schema } from 'effect'

import { BackboneElement, CodeableConcept } from '../../data-types/index.ts'
import type { BackboneElementEncoded } from '../../data-types/index.ts'

const fields = {
  language: Schema.suspend(() => CodeableConcept),
  preferred: Schema.UndefinedOr(Schema.Boolean).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of a {@link PatientCommunication}. */
export interface PatientCommunicationEncoded
  extends Schema.Struct.Encoded<typeof fields>, BackboneElementEncoded<'PatientCommunication'> {}

/** A language spoken by the patient, with an optional preference flag. */
export class PatientCommunication extends BackboneElement(
  'PatientCommunication'
).extend<PatientCommunication>('PatientCommunication')(fields) {}
