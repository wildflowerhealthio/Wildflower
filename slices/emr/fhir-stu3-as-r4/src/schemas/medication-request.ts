import { ParseResult, Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import {
  Annotation,
  BackboneElement,
  ChoiceElementSet,
  choiceElementSetPassthroughFields,
  DomainResource,
  Duration,
  IdentifierAndReference,
  Period,
  Quantity,
  SimpleQuantity,
} from 'fhir-r4/data-types'
import {
  MedicationRequest as R4MedicationRequest,
  MedicationRequestDispenseRequest as R4DispenseRequest,
} from 'fhir-r4/resources'

import { toSimpleQuantity } from './internal.ts'

/**
 * FHIR STU3 `MedicationRequest.status` value set. Identical members to R4, so it
 * maps through unchanged.
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
 * instance-order. A strict subset of the R4 intent set.
 */
const IntentSchema = Schema.Literal('proposal', 'plan', 'order', 'instance-order')

/**
 * STU3 `MedicationRequest.requester` — a backbone with an `agent` reference (the
 * prescriber) and optional `onBehalfOf`. This is the headline STU3→R4 delta: R4
 * flattens `requester` to a plain reference (dropping `onBehalfOf`).
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
 * (from `DomainResource.fields`) holds the STU3 `Medication`, carried verbatim.
 */
const MedicationRequestStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('MedicationRequest') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: identifierArray,
      status: StatusSchema,
      intent: IntentSchema,
      ...choiceElementSetPassthroughFields(
        'medication',
        ChoiceElementSet.FhirR4SetChoices['MedicationRequest.medication[x]']
      ),
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

// --- dispenseRequest backbone transform ---------------------------------------

/** STU3 `dispenseRequest` backbone → decoded R4 backbone (quantity widened). */
const dispenseToR4 = (dr: DispenseRequestType): typeof R4DispenseRequest.Schema.Type => ({
  ...R4DispenseRequest.empty,
  id: dr.id,
  extension: dr.extension,
  modifierExtension: dr.modifierExtension,
  validityPeriod: dr.validityPeriod,
  numberOfRepeatsAllowed: dr.numberOfRepeatsAllowed,
  quantity: dr.quantity === null ? null : Quantity.fromSimpleQuantity(dr.quantity),
  expectedSupplyDuration: dr.expectedSupplyDuration,
})

/** First R4-only `dispenseRequest` field STU3 can't hold, or `null`. */
const dispenseUnrepresentable = (dr: typeof R4DispenseRequest.Schema.Type): string | null => {
  if (dr.initialFill !== null) return 'dispenseRequest.initialFill'
  if (dr.dispenseInterval !== null) return 'dispenseRequest.dispenseInterval'
  if (dr.performer !== null) return 'dispenseRequest.performer'
  if (dr.quantity?.comparator != null) return 'dispenseRequest.quantity.comparator'
  return null
}

/** Decoded R4 `dispenseRequest` → STU3 backbone (representability pre-verified). */
const dispenseFromR4 = (dr: typeof R4DispenseRequest.Schema.Type): DispenseRequestType => ({
  id: dr.id,
  extension: dr.extension,
  modifierExtension: dr.modifierExtension,
  numberOfRepeatsAllowed: dr.numberOfRepeatsAllowed,
  quantity: toSimpleQuantity(dr.quantity),
  expectedSupplyDuration: dr.expectedSupplyDuration,
  validityPeriod: dr.validityPeriod,
})

// --- MedicationRequest transform ----------------------------------------------

/**
 * STU3 `MedicationRequest` → decoded R4 `MedicationRequest`. `requester.agent` →
 * R4 `requester` reference (dropping STU3-only `onBehalfOf`); STU3 `context` →
 * R4 `encounter`; `status`/`intent` map through (STU3 is a subset). Contained
 * `Medication` and carebook extensions ride through verbatim. R4-only fields
 * default from {@link R4MedicationRequest.empty}.
 */
const toR4 = (source: Type): typeof R4MedicationRequest.Schema.Type => ({
  ...R4MedicationRequest.empty,
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
  intent: source.intent,
  medicationCodeableConcept: source.medicationCodeableConcept,
  medicationReference: source.medicationReference,
  subject: source.subject,
  encounter: source.context,
  authoredOn: source.authoredOn,
  requester: source.requester === null ? null : source.requester.agent,
  note: source.note,
  dispenseRequest: source.dispenseRequest === null ? null : dispenseToR4(source.dispenseRequest),
})

/** Narrow an R4 intent to the STU3 subset, or `null` if R4-only. */
const narrowIntent = (
  intent: typeof R4MedicationRequest.IntentSchema.Type
): typeof IntentSchema.Type | null => (Schema.is(IntentSchema)(intent) ? intent : null)

/**
 * First R4-only field STU3 has no slot for, or `null` if the value is entirely
 * representable as STU3.
 */
const unrepresentableField = (r4: typeof R4MedicationRequest.Schema.Type): string | null => {
  if (r4.statusReason !== null) return 'MedicationRequest.statusReason'
  if (r4.category.length > 0) return 'MedicationRequest.category'
  if (r4.priority !== null) return 'MedicationRequest.priority'
  if (r4.doNotPerform !== null) return 'MedicationRequest.doNotPerform'
  if (r4.reportedBoolean !== null || r4.reportedReference !== null)
    return 'MedicationRequest.reported'
  if (r4.supportingInformation.length > 0) return 'MedicationRequest.supportingInformation'
  if (r4.performer !== null) return 'MedicationRequest.performer'
  if (r4.performerType !== null) return 'MedicationRequest.performerType'
  if (r4.recorder !== null) return 'MedicationRequest.recorder'
  if (r4.reasonCode.length > 0) return 'MedicationRequest.reasonCode'
  if (r4.reasonReference.length > 0) return 'MedicationRequest.reasonReference'
  if (r4.instantiatesCanonical.length > 0) return 'MedicationRequest.instantiatesCanonical'
  if (r4.instantiatesUri.length > 0) return 'MedicationRequest.instantiatesUri'
  if (r4.basedOn.length > 0) return 'MedicationRequest.basedOn'
  if (r4.groupIdentifier !== null) return 'MedicationRequest.groupIdentifier'
  if (r4.courseOfTherapyType !== null) return 'MedicationRequest.courseOfTherapyType'
  if (r4.insurance.length > 0) return 'MedicationRequest.insurance'
  if (r4.dosageInstruction.length > 0) return 'MedicationRequest.dosageInstruction'
  if (r4.substitution !== null) return 'MedicationRequest.substitution'
  if (r4.priorPrescription !== null) return 'MedicationRequest.priorPrescription'
  if (r4.detectedIssue.length > 0) return 'MedicationRequest.detectedIssue'
  if (r4.eventHistory.length > 0) return 'MedicationRequest.eventHistory'
  if (r4.dispenseRequest !== null) {
    const dispenseField = dispenseUnrepresentable(r4.dispenseRequest)
    if (dispenseField !== null) return `MedicationRequest.${dispenseField}`
  }
  return null
}

/** Decoded R4 `MedicationRequest` → STU3 (intent pre-narrowed, R4-only fields verified absent). */
const fromR4 = (
  r4: typeof R4MedicationRequest.Schema.Type,
  intent: typeof IntentSchema.Type
): Type => ({
  resourceType: 'MedicationRequest',
  id: r4.id,
  meta: r4.meta,
  implicitRules: r4.implicitRules,
  language: r4.language,
  text: r4.text,
  contained: r4.contained,
  extension: r4.extension,
  modifierExtension: r4.modifierExtension,
  identifier: r4.identifier,
  status: r4.status,
  intent,
  medicationCodeableConcept: r4.medicationCodeableConcept,
  medicationReference: r4.medicationReference,
  subject: r4.subject,
  context: r4.encounter,
  authoredOn: r4.authoredOn,
  requester:
    r4.requester === null
      ? null
      : { id: null, extension: [], modifierExtension: [], agent: r4.requester, onBehalfOf: null },
  note: r4.note,
  dispenseRequest: r4.dispenseRequest === null ? null : dispenseFromR4(r4.dispenseRequest),
})

/**
 * Decodes a carebook STU3 `MedicationRequest` wire payload straight to the
 * fhir-r4 slice's decoded `MedicationRequest`. Encoding back to STU3 fails (via
 * `ParseResult`) when the R4 value carries data — an R4-only field or an R4-only
 * intent — outside the STU3-representable subset.
 */
// Decoding through this fills the `optionalWith` defaults, so the encode
// callback can re-normalize the encoded side (absent optionals arrive as
// `undefined`) back to proper `null`s before inspecting fields.
const R4RequestType = Schema.typeSchema(R4MedicationRequest.Schema)

const R4FromStu3Schema: Schema.Schema<
  typeof R4MedicationRequest.Schema.Type,
  typeof MedicationRequestStruct.Encoded,
  never
> = Schema.transformOrFail(MedicationRequestSchema, R4RequestType, {
  strict: true,
  decode: (source) => ParseResult.succeed(toR4(source)),
  encode: (r4Raw, _options, ast) => {
    const r4 = Schema.decodeSync(R4RequestType)(r4Raw)
    const intent = narrowIntent(r4.intent)
    if (intent === null) {
      return ParseResult.fail(
        new ParseResult.Type(
          ast,
          r4,
          `MedicationRequest.intent '${r4.intent}' has no STU3 representation`
        )
      )
    }
    const field = unrepresentableField(r4)
    return field === null
      ? ParseResult.succeed(fromR4(r4, intent))
      : ParseResult.fail(new ParseResult.Type(ast, r4, `${field} has no STU3 representation`))
  },
})

export {
  MedicationRequestSchema as Schema,
  R4FromStu3Schema,
  StatusSchema,
  IntentSchema,
  RequesterSchema,
  DispenseRequestSchema,
  type Type,
  type RequesterType,
  type DispenseRequestType,
}
