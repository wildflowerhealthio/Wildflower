import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import {
  Annotation,
  BackboneElement,
  CodeableConcept,
  DomainResource,
  Duration,
  IdentifierAndReference,
  Period,
  SimpleQuantity,
} from 'fhir-r4/data-types'
import type * as FhirR4 from 'fhir/r4.d.ts'

import type {
  Stu3BackboneElementEncoded,
  Stu3BackboneElementFields,
  Stu3DomainResourceEncoded,
  Stu3DomainResourceFields,
} from './base.ts'

/**
 * FHIR STU3 `MedicationRequest.status` value set. Identical members to R4, so
 * the transform maps it through unchanged.
 */
const StatusSchema = Schema.Literal(
  'active',
  'on-hold',
  'cancelled',
  'completed',
  'entered-in-error',
  'stopped',
  'draft',
  'unknown'
)

/**
 * FHIR STU3 `MedicationRequest.intent` value set: proposal | plan | order |
 * instance-order. A strict subset of the R4 intent set, so it maps through
 * unchanged. The carebook `order` / `refill` distinction rides on the
 * {@link carebook.CarebookExtension.RequestType} extension, not on `intent`.
 */
const IntentSchema = Schema.Literal('proposal', 'plan', 'order', 'instance-order')

// The encoded (wire) sides below are spelled out explicitly against the FHIR R4
// wire types the reused fhir-r4 datatype schemas encode to, so the generated
// `.d.ts` never has to name fhir-r4's internal decoded interfaces — see
// `base.ts` and TS2883.

/**
 * STU3 `MedicationRequest.requester` — a backbone with an `agent` reference
 * (the prescriber) and optional `onBehalfOf`. This is the headline STU3→R4
 * delta: R4 flattens `requester` to a plain reference.
 */
const RequesterStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    agent: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
    onBehalfOf: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
  })
)

interface RequesterType extends Stu3BackboneElementFields {
  readonly agent: IdentifierAndReference.ReferenceType
  readonly onBehalfOf: IdentifierAndReference.ReferenceType | null
}

interface RequesterEncoded extends Stu3BackboneElementEncoded {
  agent: FhirR4.Reference
  onBehalfOf?: FhirR4.Reference | undefined
}

const RequesterSchema: Schema.Schema<RequesterType, RequesterEncoded, never> = RequesterStruct

/**
 * STU3 `MedicationRequest.dispenseRequest`. The carebook
 * `number-of-repeats-available` modifierExtension is captured by
 * `BackboneElement.fields`' `modifierExtension` array.
 */
const DispenseRequestStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    numberOfRepeatsAllowed: OrNullAsOptional(Schema.Int.pipe(Schema.nonNegative())),
    quantity: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
    expectedSupplyDuration: OrNullAsOptional(Schema.suspend(() => Duration.Schema)),
    validityPeriod: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
  })
)

interface DispenseRequestType extends Stu3BackboneElementFields {
  readonly numberOfRepeatsAllowed: number | null
  readonly quantity: typeof SimpleQuantity.Schema.Type | null
  readonly expectedSupplyDuration: typeof Duration.Schema.Type | null
  readonly validityPeriod: typeof Period.Schema.Type | null
}

interface DispenseRequestEncoded extends Stu3BackboneElementEncoded {
  numberOfRepeatsAllowed?: number | undefined
  quantity?: FhirR4.Quantity | undefined
  expectedSupplyDuration?: FhirR4.Duration | undefined
  validityPeriod?: FhirR4.Period | undefined
}

const DispenseRequestSchema: Schema.Schema<DispenseRequestType, DispenseRequestEncoded, never> =
  DispenseRequestStruct

const identifierArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
  { default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [] }
)

const annotationArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
  { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
)

/**
 * Just-enough carebook STU3 `MedicationRequest`. Models only the fields the
 * dialect emits; unknown fields/extensions are ignored on decode. `contained`
 * (from `DomainResource.fields`) holds the STU3 `Medication` — decoded on
 * demand by the transform via {@link medication.Schema}.
 */
const MedicationRequestStruct = mutableEncoded(
  StructNoContext({
    resourceType: Schema.Literal('MedicationRequest'),
    ...DomainResource.fields,
    identifier: identifierArray,
    status: StatusSchema,
    intent: IntentSchema,
    medicationReference: OrNullAsOptional(
      Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
    ),
    medicationCodeableConcept: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
    context: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
    authoredOn: OrNullAsOptional(Schema.DateTimeUtc),
    requester: OrNullAsOptional(RequesterSchema),
    note: annotationArray,
    dispenseRequest: OrNullAsOptional(DispenseRequestSchema),
  })
)

interface Type extends Stu3DomainResourceFields {
  readonly resourceType: 'MedicationRequest'
  readonly identifier: readonly IdentifierAndReference.IdentifierType[]
  readonly status: typeof StatusSchema.Type
  readonly intent: typeof IntentSchema.Type
  readonly medicationReference: IdentifierAndReference.ReferenceType | null
  readonly medicationCodeableConcept: typeof CodeableConcept.Schema.Type | null
  readonly subject: IdentifierAndReference.ReferenceType
  readonly context: IdentifierAndReference.ReferenceType | null
  readonly authoredOn: typeof Schema.DateTimeUtc.Type | null
  readonly requester: RequesterType | null
  readonly note: readonly (typeof Annotation.Schema.Type)[]
  readonly dispenseRequest: DispenseRequestType | null
}

interface Encoded extends Stu3DomainResourceEncoded {
  resourceType: 'MedicationRequest'
  identifier?: FhirR4.Identifier[] | undefined
  status: typeof StatusSchema.Type
  intent: typeof IntentSchema.Type
  medicationReference?: FhirR4.Reference | undefined
  medicationCodeableConcept?: FhirR4.CodeableConcept | undefined
  subject: FhirR4.Reference
  context?: FhirR4.Reference | undefined
  authoredOn?: string | undefined
  requester?: RequesterEncoded | undefined
  note?: FhirR4.Annotation[] | undefined
  dispenseRequest?: DispenseRequestEncoded | undefined
}

const MedicationRequestSchema: Schema.Schema<Type, Encoded, never> = MedicationRequestStruct

export {
  MedicationRequestSchema as Schema,
  StatusSchema,
  IntentSchema,
  RequesterSchema,
  DispenseRequestSchema,
  type Type,
  type Encoded,
  type RequesterType,
  type RequesterEncoded,
  type DispenseRequestType,
  type DispenseRequestEncoded,
}
