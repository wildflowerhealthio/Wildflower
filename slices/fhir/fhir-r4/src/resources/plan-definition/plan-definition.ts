import { Schema } from 'effect'

import {
  PermissivePassthrough,
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'
import '../../data-types/register-all.ts'
import * as PlanDefinitionAction from './plan-definition-action.ts'

const planDefinitionJsonSchema = {
  type: 'object',
  title: 'PlanDefinition',
  description:
    'A pre-defined group of actions to be taken in particular circumstances, often including conditional elements, options, and other decision points.',
  required: ['resourceType', 'status'],
  properties: {
    resourceType: { type: 'string', enum: ['PlanDefinition'] },
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
    url: {
      type: 'string',
      format: 'uri',
      description: 'Canonical identifier for this plan definition, represented as a URI.',
    },
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'Additional identifier for the plan definition.',
    },
    version: { type: 'string', description: 'Business version of the plan definition.' },
    name: {
      type: 'string',
      description: 'Name for this plan definition (computer friendly).',
    },
    title: { type: 'string', description: 'Name for this plan definition (human friendly).' },
    subtitle: { type: 'string', description: 'Subordinate title of the plan definition.' },
    type: {
      type: 'object',
      description: 'order-set | clinical-protocol | eca-rule | workflow-definition.',
    },
    status: {
      type: 'string',
      enum: ['draft', 'active', 'retired', 'unknown'],
      description: 'The status of this plan definition.',
    },
    experimental: {
      type: 'boolean',
      description: 'For testing purposes, not real usage.',
    },
    subjectCodeableConcept: { type: 'object' },
    subjectReference: { type: 'object' },
    date: { type: 'string', format: 'date-time', description: 'Date last changed.' },
    publisher: {
      type: 'string',
      description: 'Name of the publisher (organization or individual).',
    },
    contact: {
      type: 'array',
      items: { type: 'object' },
      description: 'Contact details for the publisher.',
    },
    description: {
      type: 'string',
      description: 'Natural language description of the plan definition.',
    },
    useContext: {
      type: 'array',
      items: { type: 'object' },
      description: 'The context that the content is intended to support.',
    },
    jurisdiction: {
      type: 'array',
      items: { type: 'object' },
      description: 'Intended jurisdiction for plan definition (if applicable).',
    },
    purpose: { type: 'string', description: 'Why this plan definition is defined.' },
    usage: { type: 'string', description: 'Describes the clinical usage of the plan.' },
    copyright: { type: 'string', description: 'Use and/or publishing restrictions.' },
    approvalDate: {
      type: 'string',
      format: 'date',
      description: 'When the plan definition was approved by publisher.',
    },
    lastReviewDate: {
      type: 'string',
      format: 'date',
      description: 'When the plan definition was last reviewed.',
    },
    effectivePeriod: {
      type: 'object',
      description: 'When the plan definition is expected to be used.',
    },
    topic: {
      type: 'array',
      items: { type: 'object' },
      description: 'E.g. Education, Treatment, Assessment.',
    },
    author: { type: 'array', items: { type: 'object' }, description: 'Who authored the content.' },
    editor: { type: 'array', items: { type: 'object' }, description: 'Who edited the content.' },
    reviewer: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who reviewed the content.',
    },
    endorser: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who endorsed the content.',
    },
    relatedArtifact: {
      type: 'array',
      items: { type: 'object' },
      description: 'Additional documentation, citations.',
    },
    library: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'Logic used by the plan definition.',
    },
    goal: {
      type: 'array',
      items: { type: 'object' },
      description: 'What the plan is trying to accomplish.',
    },
    action: {
      type: 'array',
      items: { type: 'object' },
      description: 'Action defined by the plan.',
    },
  },
} as const

/**
 * FHIR R4 value set for `PlanDefinition.status` (the `publication-status`
 * binding): draft | active | retired | unknown.
 */
const StatusSchema = Schema.Literal('draft', 'active', 'retired', 'unknown')

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const passthroughArray = Schema.optionalWith(mutableEncoded(Schema.Array(PermissivePassthrough)), {
  default: (): readonly unknown[] => [],
})

const PlanDefinitionStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('PlanDefinition') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      id: OrNullAsOptional(Schema.String),
      url: OrNullAsOptional(Schema.String),
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      version: OrNullAsOptional(Schema.String),
      name: OrNullAsOptional(Schema.String),
      title: OrNullAsOptional(Schema.String),
      subtitle: OrNullAsOptional(Schema.String),
      type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      status: StatusSchema,
      experimental: OrNullAsOptional(Schema.Boolean),
      ...choiceElementSetPassthroughFields(
        'subject',
        ChoiceElementSet.FhirR4SetChoices['PlanDefinition.subject[x]']
      ),
      date: OrNullAsOptional(Schema.String),
      publisher: OrNullAsOptional(Schema.String),
      contact: passthroughArray,
      description: OrNullAsOptional(Schema.String),
      useContext: passthroughArray,
      jurisdiction: codeableConceptArray,
      purpose: OrNullAsOptional(Schema.String),
      usage: OrNullAsOptional(Schema.String),
      copyright: OrNullAsOptional(Schema.String),
      approvalDate: OrNullAsOptional(Schema.String),
      lastReviewDate: OrNullAsOptional(Schema.String),
      effectivePeriod: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
      topic: codeableConceptArray,
      author: passthroughArray,
      editor: passthroughArray,
      reviewer: passthroughArray,
      endorser: passthroughArray,
      relatedArtifact: passthroughArray,
      library: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
        default: (): readonly string[] => [],
      }),
      goal: passthroughArray,
      action: Schema.optionalWith(mutableEncoded(Schema.Array(PlanDefinitionAction.Schema)), {
        default: (): readonly PlanDefinitionAction.Type[] => [],
      }),
    })
  )
)
  .pipe(
    filterForExclusiveChoiceElementSet(
      'subject',
      ChoiceElementSet.FhirR4SetChoices['PlanDefinition.subject[x]']
    )
  )
  .annotations({ jsonSchema: planDefinitionJsonSchema })

/**
 * Wire schema for a FHIR R4 `PlanDefinition` — a pre-defined, shareable group
 * of actions (an order set, protocol or workflow), independent of any patient.
 *
 * @remarks
 * `subject[x]` allows at most one populated slot. `goal` and the metadata
 * arrays (`contact`, `useContext`, `author`, `editor`, `reviewer`, `endorser`,
 * `relatedArtifact`) pass through untyped; `action` is typed through
 * {@link PlanDefinitionAction.Schema}, recursively.
 */
const PlanDefinitionSchema: Schema.Schema<
  typeof PlanDefinitionStruct.Type,
  FhirR4.PlanDefinition,
  never
> = PlanDefinitionStruct

/** A decoded `PlanDefinition` — the type {@link PlanDefinitionSchema} produces. */
type Type = typeof PlanDefinitionSchema.Type

export { PlanDefinitionSchema as Schema, StatusSchema }
export type { Type }
