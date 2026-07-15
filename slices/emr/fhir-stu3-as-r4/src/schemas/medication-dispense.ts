import { ParseResult, Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import {
  ChoiceElementSet,
  choiceElementSetPassthroughFields,
  DomainResource,
  IdentifierAndReference,
  Quantity,
  SimpleQuantity,
} from 'fhir-r4/data-types'
import { MedicationDispense as R4MedicationDispense } from 'fhir-r4/resources'

import { toSimpleQuantity } from './internal.ts'

/**
 * FHIR STU3 `MedicationDispense.status` value set: preparation | in-progress |
 * on-hold | completed | entered-in-error | stopped. A strict subset of the R4
 * dispense-status set, so it maps through unchanged.
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
      ...choiceElementSetPassthroughFields(
        'medication',
        ChoiceElementSet.FhirR4SetChoices['MedicationDispense.medication[x]']
      ),
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

/**
 * STU3 `MedicationDispense` → decoded R4 `MedicationDispense`. `context` maps
 * through; `SimpleQuantity` values are widened to R4 `Quantity`; STU3 status is
 * a subset of R4's, so it maps unchanged. R4-only fields default from
 * {@link R4MedicationDispense.empty}.
 */
const toR4 = (source: Type): typeof R4MedicationDispense.Schema.Type => ({
  ...R4MedicationDispense.empty,
  id: source.id,
  meta: source.meta,
  implicitRules: source.implicitRules,
  language: source.language,
  text: source.text,
  contained: source.contained,
  extension: source.extension,
  modifierExtension: source.modifierExtension,
  identifier: source.identifier,
  status: source.status,
  medicationCodeableConcept: source.medicationCodeableConcept,
  medicationReference: source.medicationReference,
  subject: source.subject,
  context: source.context,
  authorizingPrescription: source.authorizingPrescription,
  quantity: source.quantity === null ? null : Quantity.fromSimpleQuantity(source.quantity),
  daysSupply: source.daysSupply === null ? null : Quantity.fromSimpleQuantity(source.daysSupply),
  whenPrepared: source.whenPrepared,
  whenHandedOver: source.whenHandedOver,
})

/** Narrow an R4 dispense status to the STU3 subset, or `null` if R4-only. */
const narrowStatus = (
  status: typeof R4MedicationDispense.StatusSchema.Type
): typeof StatusSchema.Type | null => (Schema.is(StatusSchema)(status) ? status : null)

/**
 * First R4-only field STU3 has no slot for, or `null` if the value is entirely
 * representable as STU3 (the widened quantities must have no `comparator`).
 */
const unrepresentableField = (r4: typeof R4MedicationDispense.Schema.Type): string | null => {
  if (r4.partOf.length > 0) return 'MedicationDispense.partOf'
  if (r4.statusReasonCodeableConcept !== null || r4.statusReasonReference !== null)
    return 'MedicationDispense.statusReason'
  if (r4.category !== null) return 'MedicationDispense.category'
  if (r4.supportingInformation.length > 0) return 'MedicationDispense.supportingInformation'
  if (r4.performer.length > 0) return 'MedicationDispense.performer'
  if (r4.location !== null) return 'MedicationDispense.location'
  if (r4.type !== null) return 'MedicationDispense.type'
  if (r4.destination !== null) return 'MedicationDispense.destination'
  if (r4.receiver.length > 0) return 'MedicationDispense.receiver'
  if (r4.note.length > 0) return 'MedicationDispense.note'
  if (r4.dosageInstruction.length > 0) return 'MedicationDispense.dosageInstruction'
  if (r4.substitution !== null) return 'MedicationDispense.substitution'
  if (r4.detectedIssue.length > 0) return 'MedicationDispense.detectedIssue'
  if (r4.eventHistory.length > 0) return 'MedicationDispense.eventHistory'
  if (r4.quantity?.comparator != null) return 'MedicationDispense.quantity.comparator'
  if (r4.daysSupply?.comparator != null) return 'MedicationDispense.daysSupply.comparator'
  return null
}

/** Decoded R4 `MedicationDispense` → STU3 (status pre-narrowed, R4-only fields verified absent). */
const fromR4 = (
  r4: typeof R4MedicationDispense.Schema.Type,
  status: typeof StatusSchema.Type
): Type => ({
  resourceType: 'MedicationDispense',
  id: r4.id,
  meta: r4.meta,
  implicitRules: r4.implicitRules,
  language: r4.language,
  text: r4.text,
  contained: r4.contained,
  extension: r4.extension,
  modifierExtension: r4.modifierExtension,
  identifier: r4.identifier,
  status,
  medicationCodeableConcept: r4.medicationCodeableConcept,
  medicationReference: r4.medicationReference,
  subject: r4.subject,
  context: r4.context,
  authorizingPrescription: r4.authorizingPrescription,
  quantity: toSimpleQuantity(r4.quantity),
  daysSupply: toSimpleQuantity(r4.daysSupply),
  whenPrepared: r4.whenPrepared,
  whenHandedOver: r4.whenHandedOver,
})

/**
 * Decodes a carebook STU3 `MedicationDispense` wire payload straight to the
 * fhir-r4 slice's decoded `MedicationDispense`. Encoding back to STU3 fails
 * (via `ParseResult`) when the R4 value carries data — an R4-only field or an
 * R4-only status — outside the STU3-representable subset.
 */
// The `to` side: decoding fills every `optionalWith` default, so the encode
// callback (which receives the encoded side, where absent optionals surface as
// `undefined`) can re-normalize to proper `null`s before inspecting fields.
const R4DispenseType = Schema.typeSchema(R4MedicationDispense.Schema)

const R4FromStu3Schema: Schema.Schema<
  typeof R4MedicationDispense.Schema.Type,
  typeof MedicationDispenseStruct.Encoded,
  never
> = Schema.transformOrFail(MedicationDispenseSchema, R4DispenseType, {
  strict: true,
  decode: (source) => ParseResult.succeed(toR4(source)),
  encode: (r4Raw, _options, ast) => {
    const r4 = Schema.decodeSync(R4DispenseType)(r4Raw)
    const status = narrowStatus(r4.status)
    if (status === null) {
      return ParseResult.fail(
        new ParseResult.Type(
          ast,
          r4,
          `MedicationDispense.status '${r4.status}' has no STU3 representation`
        )
      )
    }
    const field = unrepresentableField(r4)
    return field === null
      ? ParseResult.succeed(fromR4(r4, status))
      : ParseResult.fail(new ParseResult.Type(ast, r4, `${field} has no STU3 representation`))
  },
})

export { MedicationDispenseSchema as Schema, R4FromStu3Schema, StatusSchema, type Type }
