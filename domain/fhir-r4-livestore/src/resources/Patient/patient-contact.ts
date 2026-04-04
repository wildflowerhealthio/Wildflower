import { Schema } from 'effect'

import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'

import type { BackboneElementEncoded } from '../../data-types/index.ts'
import {
  Address,
  AdministrativeGender,
  BackboneElement,
  CodeableConcept,
  ContactPoint,
  HumanName,
  Period,
  Reference,
} from '../../data-types/index.ts'

const fields = {
  address: Schema.UndefinedOr(Schema.suspend(() => Address)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  gender: Schema.UndefinedOr(AdministrativeGender).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  name: Schema.UndefinedOr(Schema.suspend(() => HumanName)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  organization: Schema.UndefinedOr(Schema.suspend(() => Reference)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  period: Schema.UndefinedOr(Schema.suspend(() => Period)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  relationship: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => CodeableConcept)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  telecom: Schema.UndefinedOr(
    Schema.Array(Schema.suspend(() => ContactPoint)).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of a {@link PatientContact}. */
export interface PatientContactEncoded
  extends Schema.Struct.Encoded<typeof fields>, BackboneElementEncoded<'PatientContact'> {}

/** A contact party (e.g. guardian, partner) for a {@link Patient}. */
export class PatientContact extends BackboneElement('PatientContact').extend<PatientContact>(
  'PatientContact'
)(fields) {}
