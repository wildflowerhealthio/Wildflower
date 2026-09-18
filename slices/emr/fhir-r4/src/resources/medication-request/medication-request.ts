import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  Annotation,
  ChoiceElementSet,
  choiceElementSetPassthroughFields,
  CodeableConcept,
  Dosage,
  DomainResource,
  IdentifierAndReference,
} from '../../data-types/index.ts'
import * as DispenseRequest from './medication-request-dispense-request.ts'
import * as Substitution from './medication-request-substitution.ts'

const medicationRequestJsonSchema = {
  type: 'object',
  title: 'MedicationRequest',
  description:
    'An order or request for both supply of the medication and the instructions for administration of the medication to a patient.',
  required: ['resourceType', 'status', 'intent', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['MedicationRequest'] },
    id: { type: 'string', description: 'Logical id of this artifact.' },
    meta: { type: 'object', description: 'Metadata about the resource.' },
    implicitRules: {
      type: 'string',
      format: 'uri',
      description: 'A set of rules under which this content was created.',
    },
    language: { type: 'string', description: 'Language of the resource content.' },
    text: { type: 'object', description: 'Human-readable summary of the resource.' },
    contained: { type: 'array', items: { type: 'object' } },
    extension: { type: 'array', items: { type: 'object' } },
    modifierExtension: { type: 'array', items: { type: 'object' } },
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'External ids for this request.',
    },
    status: {
      type: 'string',
      enum: [
        'active',
        'on-hold',
        'cancelled',
        'completed',
        'entered-in-error',
        'stopped',
        'draft',
        'unknown',
      ],
      description: 'A code specifying the current state of the order.',
    },
    statusReason: {
      type: 'object',
      description: 'Captures the reason for the current state of the MedicationRequest.',
    },
    intent: {
      type: 'string',
      enum: [
        'proposal',
        'plan',
        'order',
        'original-order',
        'reflex-order',
        'filler-order',
        'instance-order',
        'option',
      ],
      description: 'Whether the request is a proposal, plan, or an original order.',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description: 'Indicates the type of medication request.',
    },
    priority: {
      type: 'string',
      enum: ['routine', 'urgent', 'asap', 'stat'],
      description: 'Indicates how quickly the Medication Request should be addressed.',
    },
    doNotPerform: {
      type: 'boolean',
      description:
        'If true indicates that the provider is asking for the medication request not to occur.',
    },
    reportedBoolean: {
      type: 'boolean',
      description: 'Reported rather than primary record.',
    },
    reportedReference: { type: 'object' },
    medicationCodeableConcept: {
      type: 'object',
      description: 'Identifies the medication being requested.',
    },
    medicationReference: { type: 'object' },
    subject: {
      type: 'object',
      description: 'Who or group medication request is for.',
    },
    encounter: {
      type: 'object',
      description: 'Encounter created as part of encounter/admission/stay.',
    },
    supportingInformation: {
      type: 'array',
      items: { type: 'object' },
      description: 'Information to support ordering of the medication.',
    },
    authoredOn: {
      type: 'string',
      format: 'date-time',
      description: 'When request was initially authored.',
    },
    requester: {
      type: 'object',
      description: 'Who/What requested the Request.',
    },
    performer: {
      type: 'object',
      description: 'Intended performer of administration.',
    },
    performerType: {
      type: 'object',
      description: 'Desired kind of performer of the medication administration.',
    },
    recorder: {
      type: 'object',
      description: 'Person who entered the request.',
    },
    reasonCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'Reason or indication for ordering or not ordering the medication.',
    },
    reasonReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'Condition or observation that supports why the prescription is being written.',
    },
    instantiatesCanonical: {
      type: 'array',
      items: { type: 'string' },
      description: 'Instantiates FHIR protocol or definition.',
    },
    instantiatesUri: {
      type: 'array',
      items: { type: 'string' },
      description: 'Instantiates external protocol or definition.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'What request fulfills.',
    },
    groupIdentifier: {
      type: 'object',
      description: 'Composite request this is part of.',
    },
    courseOfTherapyType: {
      type: 'object',
      description: 'Overall pattern of medication administration.',
    },
    insurance: {
      type: 'array',
      items: { type: 'object' },
      description: 'Associated insurance coverage.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Information about the prescription.',
    },
    dosageInstruction: {
      type: 'array',
      items: { type: 'object' },
      description: 'How the medication should be taken.',
    },
    dispenseRequest: {
      type: 'object',
      description: 'Medication supply authorization.',
    },
    substitution: {
      type: 'object',
      description: 'Any restrictions on medication substitution.',
    },
    priorPrescription: {
      type: 'object',
      description: 'An order/prescription that is being replaced.',
    },
    detectedIssue: {
      type: 'array',
      items: { type: 'object' },
      description: 'Clinical Issue with action.',
    },
    eventHistory: {
      type: 'array',
      items: { type: 'object' },
      description: 'A list of events of interest in the lifecycle.',
    },
  },
} as const

/**
 * FHIR R4 value set for `MedicationRequest.status`: active | on-hold |
 * cancelled | completed | entered-in-error | stopped | draft | unknown.
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
 * FHIR R4 value set for `MedicationRequest.intent`: proposal | plan | order |
 * original-order | reflex-order | filler-order | instance-order | option.
 */
const IntentSchema = Schema.Literal(
  'proposal',
  'plan',
  'order',
  'original-order',
  'reflex-order',
  'filler-order',
  'instance-order',
  'option'
)

/** FHIR R4 value set for `MedicationRequest.priority`: routine | urgent | asap | stat. */
const PrioritySchema = Schema.Literal('routine', 'urgent', 'asap', 'stat')

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const stringArray = Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
  default: (): readonly string[] => [],
})

const MedicationRequestStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('MedicationRequest') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      status: StatusSchema,
      statusReason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      intent: IntentSchema,
      category: codeableConceptArray,
      priority: OrNullAsOptional(PrioritySchema),
      doNotPerform: OrNullAsOptional(Schema.Boolean),
      ...choiceElementSetPassthroughFields(
        'reported',
        ChoiceElementSet.FhirR4SetChoices['MedicationRequest.reported[x]']
      ),
      ...choiceElementSetPassthroughFields(
        'medication',
        ChoiceElementSet.FhirR4SetChoices['MedicationRequest.medication[x]']
      ),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      supportingInformation: referenceArray,
      authoredOn: OrNullAsOptional(Schema.DateTimeUtc),
      requester: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      performer: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      performerType: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      recorder: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      reasonCode: codeableConceptArray,
      reasonReference: referenceArray,
      instantiatesCanonical: stringArray,
      instantiatesUri: stringArray,
      basedOn: referenceArray,
      groupIdentifier: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.IdentifierSchema)
      ),
      courseOfTherapyType: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      insurance: referenceArray,
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        {
          default: (): readonly (typeof Annotation.Schema.Type)[] => [],
        }
      ),
      dosageInstruction: Schema.optionalWith(mutableEncoded(Schema.Array(Dosage.Schema)), {
        default: (): readonly (typeof Dosage.Schema.Type)[] => [],
      }),
      dispenseRequest: OrNullAsOptional(DispenseRequest.Schema),
      substitution: OrNullAsOptional(Substitution.Schema),
      priorPrescription: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
      ),
      detectedIssue: referenceArray,
      eventHistory: referenceArray,
    })
  )
).annotations({ jsonSchema: medicationRequestJsonSchema })

/**
 * All-empty R4 `MedicationRequest`: every field carries its "absent" value.
 * Spread it to build a request that overwrites only the slots a source
 * populates. `status` / `intent` / `subject` are required, so their
 * placeholders here are only observed if a caller forgets to overwrite them.
 */
const empty: typeof MedicationRequestStruct.Type = {
  resourceType: 'MedicationRequest',
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'unknown',
  statusReason: null,
  intent: 'order',
  category: [],
  priority: null,
  doNotPerform: null,
  reportedBoolean: null,
  reportedReference: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: IdentifierAndReference.emptyReference,
  encounter: null,
  supportingInformation: [],
  authoredOn: null,
  requester: null,
  performer: null,
  performerType: null,
  recorder: null,
  reasonCode: [],
  reasonReference: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  groupIdentifier: null,
  courseOfTherapyType: null,
  insurance: [],
  note: [],
  dosageInstruction: [],
  dispenseRequest: null,
  substitution: null,
  priorPrescription: null,
  detectedIssue: [],
  eventHistory: [],
}

const MedicationRequestSchema: Schema.Schema<
  typeof MedicationRequestStruct.Type,
  FhirR4.MedicationRequest,
  never
> = MedicationRequestStruct

/** A decoded `MedicationRequest` — the type {@link MedicationRequestSchema} produces. */
type Type = typeof MedicationRequestSchema.Type

export { MedicationRequestSchema as Schema, StatusSchema, IntentSchema, PrioritySchema, empty }
export type { Type }
