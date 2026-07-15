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

type RequesterType = typeof RequesterStruct.Type

const RequesterSchema: Schema.Schema<RequesterType, typeof RequesterStruct.Encoded, never> =
  RequesterStruct

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

type DispenseRequestType = typeof DispenseRequestStruct.Type

const DispenseRequestSchema: Schema.Schema<
  DispenseRequestType,
  typeof DispenseRequestStruct.Encoded,
  never
> = DispenseRequestStruct

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
const MedicationRequestStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('MedicationRequest') }),
  mutableEncoded(
    StructNoContext({
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
)

type Type = typeof MedicationRequestStruct.Type

const MedicationRequestSchema: Schema.Schema<Type, typeof MedicationRequestStruct.Encoded, never> =
  MedicationRequestStruct

export {
  MedicationRequestSchema as Schema,
  StatusSchema,
  IntentSchema,
  RequesterSchema,
  DispenseRequestSchema,
  type Type,
  type RequesterType,
  type DispenseRequestType,
}
