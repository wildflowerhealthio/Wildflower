import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import {
  CodeableConcept,
  DomainResource,
  IdentifierAndReference,
  SimpleQuantity,
} from 'fhir-r4/data-types'
import type * as FhirR4 from 'fhir/r4.d.ts'

import type { Stu3DomainResourceEncoded, Stu3DomainResourceFields } from './base.ts'

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
const MedicationDispenseStruct = mutableEncoded(
  StructNoContext({
    resourceType: Schema.Literal('MedicationDispense'),
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

interface Type extends Stu3DomainResourceFields {
  readonly resourceType: 'MedicationDispense'
  readonly identifier: readonly IdentifierAndReference.IdentifierType[]
  readonly status: typeof StatusSchema.Type
  readonly medicationReference: IdentifierAndReference.ReferenceType | null
  readonly medicationCodeableConcept: typeof CodeableConcept.Schema.Type | null
  readonly subject: IdentifierAndReference.ReferenceType | null
  readonly context: IdentifierAndReference.ReferenceType | null
  readonly authorizingPrescription: readonly IdentifierAndReference.ReferenceType[]
  readonly quantity: typeof SimpleQuantity.Schema.Type | null
  readonly daysSupply: typeof SimpleQuantity.Schema.Type | null
  readonly whenPrepared: typeof Schema.DateTimeUtc.Type | null
  readonly whenHandedOver: typeof Schema.DateTimeUtc.Type | null
}

interface Encoded extends Stu3DomainResourceEncoded {
  resourceType: 'MedicationDispense'
  identifier?: FhirR4.Identifier[] | undefined
  status: typeof StatusSchema.Type
  medicationReference?: FhirR4.Reference | undefined
  medicationCodeableConcept?: FhirR4.CodeableConcept | undefined
  subject?: FhirR4.Reference | undefined
  context?: FhirR4.Reference | undefined
  authorizingPrescription?: FhirR4.Reference[] | undefined
  quantity?: FhirR4.Quantity | undefined
  daysSupply?: FhirR4.Quantity | undefined
  whenPrepared?: string | undefined
  whenHandedOver?: string | undefined
}

const MedicationDispenseSchema: Schema.Schema<Type, Encoded, never> = MedicationDispenseStruct

export { MedicationDispenseSchema as Schema, StatusSchema, type Type, type Encoded }
