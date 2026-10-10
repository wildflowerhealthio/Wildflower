import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as Annotation from '../../data-types/complex/annotation.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import '../../data-types/register-all.ts'
import * as GoalTarget from './goal-target.ts'

const goalJsonSchema = {
  type: 'object',
  title: 'Goal',
  description:
    'Describes the intended objective(s) for a patient, group or organization care, for example, weight loss, restoring an activity of daily living, obtaining herd immunity via immunization, meeting a process improvement objective, etc.',
  required: ['resourceType', 'lifecycleStatus', 'description', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['Goal'] },
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
      description: 'Business identifiers assigned to this goal by the performer or other systems.',
    },
    lifecycleStatus: {
      type: 'string',
      enum: [
        'proposed',
        'planned',
        'accepted',
        'active',
        'on-hold',
        'completed',
        'cancelled',
        'entered-in-error',
        'rejected',
      ],
      description: 'The state of the goal throughout its lifecycle.',
    },
    achievementStatus: {
      type: 'object',
      description:
        'Describes the progression, or lack thereof, towards the goal against the target.',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description: 'Indicates a category the goal falls within.',
    },
    priority: {
      type: 'object',
      description:
        'Identifies the mutually agreed level of importance associated with reaching the goal.',
    },
    description: {
      type: 'object',
      description:
        'Human-readable and/or coded description of a specific desired objective of care.',
    },
    subject: {
      type: 'object',
      description:
        'Identifies the patient, group or organization for whom the goal is being established.',
    },
    startDate: { type: 'string', format: 'date' },
    startCodeableConcept: { type: 'object' },
    target: {
      type: 'array',
      items: { type: 'object' },
      description: 'Indicates what should be done by when.',
    },
    statusDate: {
      type: 'string',
      format: 'date',
      description: 'Identifies when the current status was set.',
    },
    statusReason: {
      type: 'string',
      description: 'Captures the reason for the current status.',
    },
    expressedBy: {
      type: 'object',
      description: 'Indicates whose goal this is — patient goal, practitioner goal, etc.',
    },
    addresses: {
      type: 'array',
      items: { type: 'object' },
      description:
        'The identified conditions and other health record elements that are intended to be addressed by the goal.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Any comments related to the goal.',
    },
    outcomeCode: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Identifies the change (or lack of change) at the point when the status of the goal is assessed.',
    },
    outcomeReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'Details of what has happened as a result of the goal being achieved or not.',
    },
  },
} as const

/**
 * FHIR R4 value set for `Goal.lifecycleStatus`: proposed | planned | accepted |
 * active | on-hold | completed | cancelled | entered-in-error | rejected.
 */
const LifecycleStatusSchema = Schema.Literal(
  'proposed',
  'planned',
  'accepted',
  'active',
  'on-hold',
  'completed',
  'cancelled',
  'entered-in-error',
  'rejected'
)

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const GoalStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Goal') }),
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
      lifecycleStatus: LifecycleStatusSchema,
      achievementStatus: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      category: codeableConceptArray,
      priority: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      description: Schema.suspend(() => CodeableConcept.Schema),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      ...choiceElementSetPassthroughFields(
        'start',
        ChoiceElementSet.FhirR4SetChoices['Goal.start[x]']
      ),
      target: Schema.optionalWith(mutableEncoded(Schema.Array(GoalTarget.Schema)), {
        default: (): readonly (typeof GoalTarget.Schema.Type)[] => [],
      }),
      statusDate: OrNullAsOptional(Schema.String),
      statusReason: OrNullAsOptional(Schema.String),
      expressedBy: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      addresses: referenceArray,
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
      ),
      outcomeCode: codeableConceptArray,
      outcomeReference: referenceArray,
    })
  )
)
  .pipe(
    filterForExclusiveChoiceElementSet('start', ChoiceElementSet.FhirR4SetChoices['Goal.start[x]'])
  )
  .annotations({ jsonSchema: goalJsonSchema })

/**
 * Wire schema for a FHIR R4 `Goal` — an intended objective of care for a
 * patient, with the targets it is measured against.
 *
 * @remarks
 * `start[x]` allows at most one populated slot; `target` carries the
 * `detail[x]` / `due[x]` choice elements and their guards.
 */
const GoalSchema: Schema.Schema<typeof GoalStruct.Type, FhirR4.Goal, never> = GoalStruct

/** A decoded `Goal` — the type {@link GoalSchema} produces. */
type Type = typeof GoalSchema.Type

export { GoalSchema as Schema, LifecycleStatusSchema }
export type { Type }
