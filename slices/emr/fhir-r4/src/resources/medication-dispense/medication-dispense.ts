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
  Quantity,
} from '../../data-types/index.ts'
import * as Performer from './medication-dispense-performer.ts'
import * as Substitution from './medication-dispense-substitution.ts'

const medicationDispenseJsonSchema = {
  type: 'object',
  title: 'MedicationDispense',
  description:
    'Indicates that a medication product is to be or has been dispensed for a named person/patient.',
  required: ['resourceType', 'status'],
  properties: {
    resourceType: { type: 'string', enum: ['MedicationDispense'] },
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
      description: 'External identifier.',
    },
    partOf: {
      type: 'array',
      items: { type: 'object' },
      description: 'Event that dispense is part of.',
    },
    status: {
      type: 'string',
      enum: [
        'preparation',
        'in-progress',
        'cancelled',
        'on-hold',
        'completed',
        'entered-in-error',
        'stopped',
        'declined',
        'unknown',
      ],
      description: 'A code specifying the state of the set of dispense events.',
    },
    statusReasonCodeableConcept: {
      type: 'object',
      description: 'Why a dispense was not performed.',
    },
    statusReasonReference: { type: 'object' },
    category: {
      type: 'object',
      description: 'Type of medication dispense.',
    },
    medicationCodeableConcept: {
      type: 'object',
      description: 'What medication was supplied.',
    },
    medicationReference: { type: 'object' },
    subject: {
      type: 'object',
      description: 'Who the dispense is for.',
    },
    context: {
      type: 'object',
      description: 'Encounter / Episode associated with event.',
    },
    supportingInformation: {
      type: 'array',
      items: { type: 'object' },
      description: 'Information that supports the dispensing of the medication.',
    },
    performer: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who performed event.',
    },
    location: {
      type: 'object',
      description: 'Where the dispense occurred.',
    },
    authorizingPrescription: {
      type: 'array',
      items: { type: 'object' },
      description: 'Medication order that authorizes the dispense.',
    },
    type: {
      type: 'object',
      description: 'Trial fill, partial fill, emergency fill, etc.',
    },
    quantity: {
      type: 'object',
      description: 'Amount dispensed.',
    },
    daysSupply: {
      type: 'object',
      description: 'Amount of medication expressed as a timing amount.',
    },
    whenPrepared: {
      type: 'string',
      format: 'date-time',
      description: 'When product was packaged and reviewed.',
    },
    whenHandedOver: {
      type: 'string',
      format: 'date-time',
      description: 'When product was given out.',
    },
    destination: {
      type: 'object',
      description: 'Where the medication was sent.',
    },
    receiver: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who collected the medication.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Information about the dispense.',
    },
    dosageInstruction: {
      type: 'array',
      items: { type: 'object' },
      description:
        'How the medication is to be used by the patient or administered by the caregiver.',
    },
    substitution: {
      type: 'object',
      description: 'Whether a substitution was performed on the dispense.',
    },
    detectedIssue: {
      type: 'array',
      items: { type: 'object' },
      description: 'Clinical issue with action.',
    },
    eventHistory: {
      type: 'array',
      items: { type: 'object' },
      description: 'A list of relevant lifecycle events.',
    },
  },
} as const

/**
 * FHIR R4 value set for `MedicationDispense.status`: preparation | in-progress
 * | cancelled | on-hold | completed | entered-in-error | stopped | declined |
 * unknown.
 */
const StatusSchema = Schema.Literal(
  'preparation',
  'in-progress',
  'cancelled',
  'on-hold',
  'completed',
  'entered-in-error',
  'stopped',
  'declined',
  'unknown'
)

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const MedicationDispenseStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('MedicationDispense') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      partOf: referenceArray,
      status: StatusSchema,
      ...choiceElementSetPassthroughFields(
        'statusReason',
        ChoiceElementSet.FhirR4SetChoices['MedicationDispense.statusReason[x]']
      ),
      category: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      ...choiceElementSetPassthroughFields(
        'medication',
        ChoiceElementSet.FhirR4SetChoices['MedicationDispense.medication[x]']
      ),
      subject: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      context: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      supportingInformation: referenceArray,
      performer: Schema.optionalWith(mutableEncoded(Schema.Array(Performer.Schema)), {
        default: (): readonly (typeof Performer.Schema.Type)[] => [],
      }),
      location: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      authorizingPrescription: referenceArray,
      type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      quantity: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
      daysSupply: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
      whenPrepared: OrNullAsOptional(Schema.DateTimeUtc),
      whenHandedOver: OrNullAsOptional(Schema.DateTimeUtc),
      destination: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      receiver: referenceArray,
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
      ),
      dosageInstruction: Schema.optionalWith(mutableEncoded(Schema.Array(Dosage.Schema)), {
        default: (): readonly (typeof Dosage.Schema.Type)[] => [],
      }),
      substitution: OrNullAsOptional(Substitution.Schema),
      detectedIssue: referenceArray,
      eventHistory: referenceArray,
    })
  )
).annotations({ jsonSchema: medicationDispenseJsonSchema })

/**
 * All-empty R4 `MedicationDispense`: every field carries its "absent" value.
 * Spread it to build a dispense that overwrites only the slots a source
 * populates. `status` is required, so its placeholder here is only observed if
 * a caller forgets to overwrite it.
 */
const empty: typeof MedicationDispenseStruct.Type = {
  resourceType: 'MedicationDispense',
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  partOf: [],
  status: 'unknown',
  statusReasonCodeableConcept: null,
  statusReasonReference: null,
  category: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: null,
  context: null,
  supportingInformation: [],
  performer: [],
  location: null,
  authorizingPrescription: [],
  type: null,
  quantity: null,
  daysSupply: null,
  whenPrepared: null,
  whenHandedOver: null,
  destination: null,
  receiver: [],
  note: [],
  dosageInstruction: [],
  substitution: null,
  detectedIssue: [],
  eventHistory: [],
}

const MedicationDispenseSchema: Schema.Schema<
  typeof MedicationDispenseStruct.Type,
  FhirR4.MedicationDispense,
  never
> = MedicationDispenseStruct

export { MedicationDispenseSchema as Schema, StatusSchema, empty }
