import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import '../../data-types/register-all.ts'

const serviceRequestJsonSchema = {
  type: 'object',
  title: 'ServiceRequest',
  description:
    'A record of a request for service such as diagnostic investigations, treatments, or operations to be performed.',
  required: ['resourceType', 'status', 'intent', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['ServiceRequest'] },
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
      description: 'Identifiers assigned to this request by the orderer or by the receiver.',
    },
    instantiatesCanonical: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'The URL pointing to a FHIR-defined protocol or definition.',
    },
    instantiatesUri: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'The URL pointing to an externally maintained protocol or definition.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'Plan/proposal/order fulfilled by this request.',
    },
    replaces: {
      type: 'array',
      items: { type: 'object' },
      description:
        'The request takes the place of the referenced completed or terminated request(s).',
    },
    requisition: {
      type: 'object',
      description:
        'A shared identifier common to all service requests that were authorized at the same time.',
    },
    status: {
      type: 'string',
      enum: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'],
      description: 'The status of the order.',
    },
    intent: {
      type: 'string',
      enum: [
        'proposal',
        'plan',
        'directive',
        'order',
        'original-order',
        'reflex-order',
        'filler-order',
        'instance-order',
        'option',
      ],
      description: 'Whether the request is a proposal, plan, or order.',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A code that classifies the service for searching, sorting, and display purposes.',
    },
    priority: {
      type: 'string',
      enum: ['routine', 'urgent', 'asap', 'stat'],
      description: 'Indicates how quickly the ServiceRequest should be addressed.',
    },
    doNotPerform: {
      type: 'boolean',
      description: 'If true, indicates that the service should NOT be performed.',
    },
    code: {
      type: 'object',
      description: 'A code that identifies a particular service that has been requested.',
    },
    orderDetail: {
      type: 'array',
      items: { type: 'object' },
      description: 'Additional details and instructions about the requested service.',
    },
    quantityQuantity: { type: 'object' },
    quantityRatio: { type: 'object' },
    quantityRange: { type: 'object' },
    subject: {
      type: 'object',
      description: 'On whom or what the service is to be performed.',
    },
    encounter: {
      type: 'object',
      description:
        'An encounter that provides additional information about the healthcare context.',
    },
    occurrenceDateTime: { type: 'string', format: 'date-time' },
    occurrencePeriod: { type: 'object' },
    occurrenceTiming: { type: 'object' },
    asNeededBoolean: { type: 'boolean' },
    asNeededCodeableConcept: { type: 'object' },
    authoredOn: {
      type: 'string',
      format: 'date-time',
      description: 'When the request transitioned to being actionable.',
    },
    requester: {
      type: 'object',
      description: 'The individual who initiated the request.',
    },
    performerType: {
      type: 'object',
      description: 'Desired type of performer for doing the requested service.',
    },
    performer: {
      type: 'array',
      items: { type: 'object' },
      description: 'The desired performer for doing the requested service.',
    },
    locationCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'The preferred location(s) where the procedure should actually happen.',
    },
    locationReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'A reference to the preferred location(s).',
    },
    reasonCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'An explanation or justification for the service being requested in coded form.',
    },
    reasonReference: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Indicates another resource that provides a justification for the service being requested.',
    },
    insurance: {
      type: 'array',
      items: { type: 'object' },
      description: 'Insurance plans, coverage extensions, and/or pre-authorizations.',
    },
    supportingInfo: {
      type: 'array',
      items: { type: 'object' },
      description: 'Additional clinical information about the patient or specimen.',
    },
    bodySite: {
      type: 'array',
      items: { type: 'object' },
      description: 'Anatomic location where the procedure should be performed.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Any other notes and comments made about the service request.',
    },
    patientInstruction: {
      type: 'string',
      description: 'Instructions in terms that are understood by the patient or consumer.',
    },
    relevantHistory: {
      type: 'array',
      items: { type: 'object' },
      description: 'Key events in the history of the request.',
    },
  },
} as const

const StatusSchema = Schema.Literal(
  'draft',
  'active',
  'on-hold',
  'revoked',
  'completed',
  'entered-in-error',
  'unknown'
)

const IntentSchema = Schema.Literal(
  'proposal',
  'plan',
  'directive',
  'order',
  'original-order',
  'reflex-order',
  'filler-order',
  'instance-order',
  'option'
)

const PrioritySchema = Schema.Literal('routine', 'urgent', 'asap', 'stat')

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const ServiceRequestStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('ServiceRequest') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      id: OrNullAsOptional(Schema.String),
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      instantiatesCanonical: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
        default: (): readonly string[] => [],
      }),
      instantiatesUri: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
        default: (): readonly string[] => [],
      }),
      basedOn: referenceArray,
      replaces: referenceArray,
      requisition: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.IdentifierSchema)),
      status: StatusSchema,
      intent: IntentSchema,
      category: codeableConceptArray,
      priority: OrNullAsOptional(PrioritySchema),
      doNotPerform: OrNullAsOptional(Schema.Boolean),
      code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      orderDetail: codeableConceptArray,
      ...choiceElementSetPassthroughFields(
        'quantity',
        ChoiceElementSet.FhirR4SetChoices['ServiceRequest.quantity[x]']
      ),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      ...choiceElementSetPassthroughFields(
        'occurrence',
        ChoiceElementSet.FhirR4SetChoices['ServiceRequest.occurrence[x]']
      ),
      ...choiceElementSetPassthroughFields(
        'asNeeded',
        ChoiceElementSet.FhirR4SetChoices['ServiceRequest.asNeeded[x]']
      ),
      authoredOn: OrNullAsOptional(Schema.String),
      requester: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      performerType: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      performer: referenceArray,
      locationCode: codeableConceptArray,
      locationReference: referenceArray,
      reasonCode: codeableConceptArray,
      reasonReference: referenceArray,
      insurance: referenceArray,
      supportingInfo: referenceArray,
      bodySite: codeableConceptArray,
      note: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
        default: (): readonly unknown[] => [],
      }),
      patientInstruction: OrNullAsOptional(Schema.String),
      relevantHistory: referenceArray,
    })
  )
)
  .pipe(
    filterForExclusiveChoiceElementSet(
      'quantity',
      ChoiceElementSet.FhirR4SetChoices['ServiceRequest.quantity[x]']
    ),
    filterForExclusiveChoiceElementSet(
      'occurrence',
      ChoiceElementSet.FhirR4SetChoices['ServiceRequest.occurrence[x]']
    ),
    filterForExclusiveChoiceElementSet(
      'asNeeded',
      ChoiceElementSet.FhirR4SetChoices['ServiceRequest.asNeeded[x]']
    )
  )
  .annotations({ jsonSchema: serviceRequestJsonSchema })

const ServiceRequestSchema: Schema.Schema<
  typeof ServiceRequestStruct.Type,
  FhirR4.ServiceRequest,
  never
> = ServiceRequestStruct

/** A decoded `ServiceRequest` — the type {@link ServiceRequestSchema} produces. */
type Type = typeof ServiceRequestSchema.Type

export { ServiceRequestSchema as Schema, StatusSchema, IntentSchema }
export type { Type }
