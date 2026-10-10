import { Schema } from 'effect'

import {
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
import * as Annotation from '../../data-types/complex/annotation.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import '../../data-types/register-all.ts'
import * as ProcedureFocalDevice from './procedure-focal-device.ts'
import * as ProcedurePerformer from './procedure-performer.ts'

const procedureJsonSchema = {
  type: 'object',
  title: 'Procedure',
  description:
    'An action that is or was performed on or for a patient. This can be a physical intervention like an operation, or less invasive like long term services, counseling, or hypnotherapy.',
  required: ['resourceType', 'status', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['Procedure'] },
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
      description: 'External Identifiers for this procedure.',
    },
    instantiatesCanonical: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'Instantiates FHIR protocol or definition.',
    },
    instantiatesUri: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'Instantiates external protocol or definition.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'A request for this procedure.',
    },
    partOf: {
      type: 'array',
      items: { type: 'object' },
      description: 'Part of referenced event.',
    },
    status: {
      type: 'string',
      enum: [
        'preparation',
        'in-progress',
        'not-done',
        'on-hold',
        'stopped',
        'completed',
        'entered-in-error',
        'unknown',
      ],
      description: 'A code specifying the state of the procedure.',
    },
    statusReason: { type: 'object', description: 'Reason for current status.' },
    category: { type: 'object', description: 'Classification of the procedure.' },
    code: { type: 'object', description: 'Identification of the procedure.' },
    subject: {
      type: 'object',
      description: 'Who the procedure was performed on.',
    },
    encounter: {
      type: 'object',
      description: 'Encounter created as part of.',
    },
    performedDateTime: { type: 'string', format: 'date-time' },
    performedPeriod: { type: 'object' },
    performedString: { type: 'string' },
    performedAge: { type: 'object' },
    performedRange: { type: 'object' },
    recorder: { type: 'object', description: 'Who recorded the procedure.' },
    asserter: { type: 'object', description: 'Person who asserts this procedure.' },
    performer: {
      type: 'array',
      items: { type: 'object' },
      description: 'The people who performed the procedure.',
    },
    location: {
      type: 'object',
      description: 'Where the procedure happened.',
    },
    reasonCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'Coded reason procedure performed.',
    },
    reasonReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'The justification that the procedure was performed.',
    },
    bodySite: {
      type: 'array',
      items: { type: 'object' },
      description: 'Target body sites.',
    },
    outcome: { type: 'object', description: 'The result of procedure.' },
    report: {
      type: 'array',
      items: { type: 'object' },
      description: 'Any report resulting from the procedure.',
    },
    complication: {
      type: 'array',
      items: { type: 'object' },
      description: 'Complication following the procedure.',
    },
    complicationDetail: {
      type: 'array',
      items: { type: 'object' },
      description: 'A condition that is a result of the procedure.',
    },
    followUp: {
      type: 'array',
      items: { type: 'object' },
      description: 'Instructions for follow up.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description: 'Additional information about the procedure.',
    },
    focalDevice: {
      type: 'array',
      items: { type: 'object' },
      description: 'Manipulated, implanted, or removed device.',
    },
    usedReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'Items used during procedure.',
    },
    usedCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'Coded items used during the procedure.',
    },
  },
} as const

/**
 * FHIR R4 value set for `Procedure.status` (the `event-status` binding):
 * preparation | in-progress | not-done | on-hold | stopped | completed |
 * entered-in-error | unknown.
 */
const StatusSchema = Schema.Literal(
  'preparation',
  'in-progress',
  'not-done',
  'on-hold',
  'stopped',
  'completed',
  'entered-in-error',
  'unknown'
)

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const ProcedureStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Procedure') }),
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
      partOf: referenceArray,
      status: StatusSchema,
      statusReason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      category: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      ...choiceElementSetPassthroughFields(
        'performed',
        ChoiceElementSet.FhirR4SetChoices['Procedure.performed[x]']
      ),
      recorder: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      asserter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      performer: Schema.optionalWith(mutableEncoded(Schema.Array(ProcedurePerformer.Schema)), {
        default: (): readonly (typeof ProcedurePerformer.Schema.Type)[] => [],
      }),
      location: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      reasonCode: codeableConceptArray,
      reasonReference: referenceArray,
      bodySite: codeableConceptArray,
      outcome: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      report: referenceArray,
      complication: codeableConceptArray,
      complicationDetail: referenceArray,
      followUp: codeableConceptArray,
      note: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
        { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
      ),
      focalDevice: Schema.optionalWith(mutableEncoded(Schema.Array(ProcedureFocalDevice.Schema)), {
        default: (): readonly (typeof ProcedureFocalDevice.Schema.Type)[] => [],
      }),
      usedReference: referenceArray,
      usedCode: codeableConceptArray,
    })
  )
)
  .pipe(
    filterForExclusiveChoiceElementSet(
      'performed',
      ChoiceElementSet.FhirR4SetChoices['Procedure.performed[x]']
    )
  )
  .annotations({ jsonSchema: procedureJsonSchema })

/**
 * Wire schema for a FHIR R4 `Procedure` — an action that is or was performed
 * on or for a patient, from surgery to a training session.
 *
 * @remarks
 * `performed[x]` allows at most one populated slot; `performedAge` is an
 * unregistered datatype, so it always decodes to `null`. `performer` and
 * `focalDevice` are typed through {@link ProcedurePerformer.Schema} and
 * {@link ProcedureFocalDevice.Schema}.
 */
const ProcedureSchema: Schema.Schema<typeof ProcedureStruct.Type, FhirR4.Procedure, never> =
  ProcedureStruct

/** A decoded `Procedure` — the type {@link ProcedureSchema} produces. */
type Type = typeof ProcedureSchema.Type

export { ProcedureSchema as Schema, StatusSchema }
export type { Type }
