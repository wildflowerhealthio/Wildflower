import { Schema } from 'effect'

import { Observation as StoreObservation } from 'emr-core/livestore'
import { ChoiceElementSet } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { choiceElementSetPassthroughFields } from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as Annotation from '../../data-types/complex/annotation.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as ObservationComponent from './observation-component.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

const observationJsonSchema = {
  type: 'object',
  title: 'Observation',
  description: 'Measurements and simple assertions made about a patient, device or other subject.',
  required: ['resourceType', 'code', 'status'],
  properties: {
    resourceType: { type: 'string', enum: ['Observation'] },
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
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'A plan, proposal or order that is fulfilled in whole or in part by this event.',
    },
    bodySite: {
      type: 'object',
      description: "Indicates the site on the subject's body where the observation was made.",
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description: 'A code that classifies the general type of observation being made.',
    },
    code: {
      type: 'object',
      description: "Describes what was observed. Sometimes this is called the observation 'name'.",
    },
    component: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Some observations have multiple component observations. These component observations are expressed as separate code value pairs that share the same attributes.',
    },
    dataAbsentReason: {
      type: 'object',
      description:
        'Provides a reason why the expected value in the element Observation.value[x] is missing.',
    },
    derivedFrom: {
      type: 'array',
      items: { type: 'object' },
      description:
        'The target resource that represents a measurement from which this observation value is derived.',
    },
    device: {
      type: 'object',
      description: 'The device used to generate the observation data.',
    },
    effectiveDateTime: {
      type: 'string',
      format: 'date-time',
      description:
        'The time or time-period the observed value is asserted as being true. At least a date should be present unless this observation is a historical report.',
    },
    effectivePeriod: { type: 'object' },
    effectiveTiming: { type: 'object' },
    effectiveInstant: { type: 'string', format: 'date-time' },
    encounter: {
      type: 'object',
      description:
        'The healthcare event (e.g. a patient and healthcare provider interaction) during which this observation is made.',
    },
    focus: {
      type: 'array',
      items: { type: 'object' },
      description:
        'The actual focus of an observation when it is not the patient of record representing something or someone associated with the patient such as a spouse, parent, fetus, or donor.',
    },
    hasMember: {
      type: 'array',
      items: { type: 'object' },
      description:
        'This observation is a group observation (e.g. a battery, a panel of tests, a set of vital sign measurements) that includes the target as a member of the group.',
    },
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'A unique identifier assigned to this observation.',
    },
    interpretation: {
      type: 'array',
      items: { type: 'object' },
      description: 'A categorical assessment of an observation value.',
    },
    issued: {
      type: 'string',
      format: 'date-time',
      description:
        'The date and time this version of the observation was made available to providers, typically after the results have been reviewed and verified.',
    },
    method: {
      type: 'object',
      description: 'Indicates the mechanism used to perform the observation.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Comments about the observation or the results.',
    },
    partOf: {
      type: 'array',
      items: { type: 'object' },
      description: 'A larger event of which this particular Observation is a component or step.',
    },
    performer: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who was responsible for asserting the observed value as "true".',
    },
    referenceRange: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Guidance on how to interpret the value by comparison to a normal or recommended range.',
    },
    specimen: {
      type: 'object',
      description: 'The specimen that was used when this observation was made.',
    },
    status: {
      type: 'string',
      enum: [
        'registered',
        'preliminary',
        'final',
        'amended',
        'corrected',
        'cancelled',
        'entered-in-error',
        'unknown',
      ],
      description: 'The status of the result value.',
    },
    subject: {
      type: 'object',
      description:
        'The patient, or group of patients, location, or device this observation is about and into whose or what record the observation is placed.',
    },
    valueQuantity: {
      type: 'object',
      description:
        'The information determined as a result of making the observation, if the information has a simple value.',
    },
    valueCodeableConcept: { type: 'object' },
    valueString: { type: 'string' },
    valueBoolean: { type: 'boolean' },
    valueInteger: { type: 'integer' },
    valueRange: { type: 'object' },
    valueRatio: { type: 'object' },
    valueSampledData: { type: 'object' },
    valueTime: { type: 'string', format: 'time' },
    valueDateTime: { type: 'string', format: 'date-time' },
    valuePeriod: { type: 'object' },
  },
} as const

const ObservationSchema: Schema.Schema<
  typeof StoreObservation.RowSchemaNullableId.Type,
  FhirR4.Observation,
  never
> = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Observation') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      id: OrNullAsOptional(Schema.String),
      basedOn: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      bodySite: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      category: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
        { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
      ),
      code: Schema.suspend(() => CodeableConcept.Schema),
      component: Schema.optionalWith(mutableEncoded(Schema.Array(ObservationComponent.Schema)), {
        default: (): readonly (typeof ObservationComponent.Schema.Type)[] => [],
      }),
      dataAbsentReason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      derivedFrom: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      device: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      focus: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      hasMember: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      interpretation: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
        { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
      ),
      issued: OrNullAsOptional(Schema.DateTimeUtc),
      method: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
      ),
      partOf: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      performer: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      referenceRange: Schema.optionalWith(
        mutableEncoded(Schema.Array(ObservationReferenceRange.Schema)),
        { default: (): readonly (typeof ObservationReferenceRange.Schema.Type)[] => [] }
      ),
      specimen: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      status: StoreObservation.StatusSchema,
      subject: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      ...choiceElementSetPassthroughFields(
        'value',
        ChoiceElementSet.FhirR4SetChoices['Observation.value[x]']
      ),
      ...choiceElementSetPassthroughFields(
        'effective',
        ChoiceElementSet.FhirR4SetChoices['Observation.effective[x]']
      ),
    })
  )
).annotations({ jsonSchema: observationJsonSchema })
export { ObservationSchema as Schema }
