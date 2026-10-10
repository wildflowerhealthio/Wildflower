import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as Annotation from '../../data-types/complex/annotation.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'
import '../../data-types/register-all.ts'
import * as CarePlanActivity from './care-plan-activity.ts'

const carePlanJsonSchema = {
  type: 'object',
  title: 'CarePlan',
  description:
    'Describes the intention of how one or more practitioners intend to deliver care for a particular patient, group or community for a period of time, possibly limited to care for a specific condition or set of conditions.',
  required: ['resourceType', 'status', 'intent', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['CarePlan'] },
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
      description:
        'Business identifiers assigned to this care plan by the performer or other systems.',
    },
    instantiatesCanonical: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description:
        'The URL pointing to a FHIR-defined protocol, guideline, questionnaire or other definition.',
    },
    instantiatesUri: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description:
        'The URL pointing to an externally maintained protocol, guideline, questionnaire or other definition.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'A care plan that is fulfilled in whole or in part by this care plan.',
    },
    replaces: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Completed or terminated care plan whose function is taken by this new care plan.',
    },
    partOf: {
      type: 'array',
      items: { type: 'object' },
      description: 'A larger care plan of which this particular care plan is a component or step.',
    },
    status: {
      type: 'string',
      enum: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'],
      description: 'Indicates whether the plan is currently being acted upon.',
    },
    intent: {
      type: 'string',
      enum: ['proposal', 'plan', 'order', 'option'],
      description: 'Indicates the level of authority/intentionality associated with the care plan.',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Identifies what "kind" of plan this is to support differentiation between plans.',
    },
    title: { type: 'string', description: 'Human-friendly name for the care plan.' },
    description: {
      type: 'string',
      description: 'A description of the scope and nature of the plan.',
    },
    subject: {
      type: 'object',
      description: 'Identifies the patient or group whose intended care is described by the plan.',
    },
    encounter: {
      type: 'object',
      description: 'The Encounter during which this CarePlan was created.',
    },
    period: {
      type: 'object',
      description: 'Indicates when the plan did (or is intended to) come into effect and end.',
    },
    created: {
      type: 'string',
      format: 'date-time',
      description: 'Represents when this particular CarePlan record was created in the system.',
    },
    author: {
      type: 'object',
      description: 'The individual, organization or device primarily responsible for the plan.',
    },
    contributor: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Identifies the individual(s) or organization who provided the contents of the care plan.',
    },
    careTeam: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Identifies all people and organizations who are expected to be involved in the care.',
    },
    addresses: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Identifies the conditions/problems/concerns/diagnoses/etc. this plan addresses.',
    },
    supportingInfo: {
      type: 'array',
      items: { type: 'object' },
      description: 'Other resources that provide context for the plan.',
    },
    goal: {
      type: 'array',
      items: { type: 'object' },
      description: 'Describes the intended objective(s) of carrying out the care plan.',
    },
    activity: {
      type: 'array',
      items: { type: 'object' },
      description: 'Identifies a planned action to occur as part of the plan.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'General notes about the care plan not covered elsewhere.',
    },
  },
} as const

/**
 * FHIR R4 value set for `CarePlan.status` (the `request-status` binding):
 * draft | active | on-hold | revoked | completed | entered-in-error | unknown.
 */
const StatusSchema = Schema.Literal(
  'draft',
  'active',
  'on-hold',
  'revoked',
  'completed',
  'entered-in-error',
  'unknown'
)

/**
 * FHIR R4 value set for `CarePlan.intent`: proposal | plan | order | option —
 * narrower than the general `request-intent` binding `ServiceRequest` uses.
 */
const IntentSchema = Schema.Literal('proposal', 'plan', 'order', 'option')

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const CarePlanStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('CarePlan') }),
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
      partOf: referenceArray,
      status: StatusSchema,
      intent: IntentSchema,
      category: codeableConceptArray,
      title: OrNullAsOptional(Schema.String),
      description: OrNullAsOptional(Schema.String),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
      created: OrNullAsOptional(Schema.String),
      author: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      contributor: referenceArray,
      careTeam: referenceArray,
      addresses: referenceArray,
      supportingInfo: referenceArray,
      goal: referenceArray,
      activity: Schema.optionalWith(mutableEncoded(Schema.Array(CarePlanActivity.Schema)), {
        default: (): readonly (typeof CarePlanActivity.Schema.Type)[] => [],
      }),
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
      ),
    })
  )
).annotations({ jsonSchema: carePlanJsonSchema })

/**
 * Wire schema for a FHIR R4 `CarePlan` — how care is intended to be delivered
 * for a patient over a period, with its goals and planned activities.
 *
 * @remarks
 * The top level has no choice elements; `activity.detail` carries the
 * `scheduled[x]` and `product[x]` choice elements and their at-most-one guards.
 */
const CarePlanSchema: Schema.Schema<typeof CarePlanStruct.Type, FhirR4.CarePlan, never> =
  CarePlanStruct

/** A decoded `CarePlan` — the type {@link CarePlanSchema} produces. */
type Type = typeof CarePlanSchema.Type

export { CarePlanSchema as Schema, StatusSchema, IntentSchema }
export type { Type }
