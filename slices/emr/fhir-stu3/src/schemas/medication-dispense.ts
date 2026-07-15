import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import {
  CodeableConcept,
  DomainResource,
  IdentifierAndReference,
  SimpleQuantity,
} from 'fhir-r4/data-types'

/**
 * FHIR STU3 `MedicationDispense.status` value set: preparation | in-progress |
 * on-hold | completed | entered-in-error | stopped. A strict subset of the R4
 * dispense-status set, so the transform maps it through unchanged.
 */
const StatusSchema = Schema.Literal(
  'preparation',
  'in-progress',
  'on-hold',
  'completed',
  'entered-in-error',
  'stopped'
)

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const identifierArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
  { default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [] }
)

/**
 * Just-enough carebook STU3 `MedicationDispense`. Models only the fields the
 * dialect emits (`authorizingPrescription`, `quantity`, `daysSupply`,
 * `whenPrepared`, `whenHandedOver`, `status`, medication choice, subject);
 * unknown fields/extensions are ignored on decode.
 */
const MedicationDispenseStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('MedicationDispense') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: identifierArray,
      status: StatusSchema,
      medicationReference: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
      ),
      medicationCodeableConcept: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      subject: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      context: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      authorizingPrescription: referenceArray,
      quantity: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
      daysSupply: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
      whenPrepared: OrNullAsOptional(Schema.DateTimeUtc),
      whenHandedOver: OrNullAsOptional(Schema.DateTimeUtc),
    })
  )
)

type Type = typeof MedicationDispenseStruct.Type

const MedicationDispenseSchema: Schema.Schema<
  Type,
  typeof MedicationDispenseStruct.Encoded,
  never
> = MedicationDispenseStruct

export { MedicationDispenseSchema as Schema, StatusSchema, type Type }
