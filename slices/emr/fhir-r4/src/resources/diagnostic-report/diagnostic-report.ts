import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  choiceElementSetExclusive,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as Attachment from '../../data-types/complex/attachment.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
// Registration barrel — imported for the side effect of running every complex
// datatype's `registerDatatypeSchema` so the `effective[x]` slot (here
// {dateTime, Period}) round-trips. See observation.ts for the rationale.
import '../../data-types/register-all.ts'
import * as DiagnosticReportMedia from './diagnostic-report-media.ts'

const diagnosticReportJsonSchema = {
  type: 'object',
  title: 'DiagnosticReport',
  description:
    'The findings and interpretation of diagnostic tests performed on patients, groups of patients, devices, and locations, and/or specimens derived from these.',
  required: ['resourceType', 'code', 'status'],
  properties: {
    resourceType: { type: 'string', enum: ['DiagnosticReport'] },
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
      description: 'Identifiers assigned to this report by the performer or other systems.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description: 'Details concerning a service requested.',
    },
    status: {
      type: 'string',
      enum: [
        'registered',
        'partial',
        'preliminary',
        'final',
        'amended',
        'corrected',
        'appended',
        'cancelled',
        'entered-in-error',
        'unknown',
      ],
      description: 'The status of the diagnostic report.',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A code that classifies the clinical discipline, department or diagnostic service that created the report.',
    },
    code: {
      type: 'object',
      description: 'A code or name that describes this diagnostic report.',
    },
    subject: {
      type: 'object',
      description: 'The subject of the report. Usually, but not always, this is a patient.',
    },
    encounter: {
      type: 'object',
      description: 'The healthcare event which this DiagnosticReport is about.',
    },
    effectiveDateTime: {
      type: 'string',
      format: 'date-time',
      description:
        'The time or time-period the observed values are related to. When the subject of the report is a patient, this is usually either the time of the procedure or of specimen collection(s).',
    },
    effectivePeriod: { type: 'object' },
    issued: {
      type: 'string',
      format: 'date-time',
      description:
        'The date and time that this version of the report was made available to providers, typically after the report was reviewed and verified.',
    },
    performer: {
      type: 'array',
      items: { type: 'object' },
      description: 'The diagnostic service that is responsible for issuing the report.',
    },
    resultsInterpreter: {
      type: 'array',
      items: { type: 'object' },
      description:
        "The practitioner or organization that is responsible for the report's conclusions and interpretations.",
    },
    specimen: {
      type: 'array',
      items: { type: 'object' },
      description: 'Details about the specimens on which this diagnostic report is based.',
    },
    result: {
      type: 'array',
      items: { type: 'object' },
      description: 'Observations that are part of this diagnostic report.',
    },
    imagingStudy: {
      type: 'array',
      items: { type: 'object' },
      description:
        'One or more links to full details of any imaging performed during the diagnostic investigation.',
    },
    media: {
      type: 'array',
      items: { type: 'object' },
      description: 'A list of key images associated with this report.',
    },
    conclusion: {
      type: 'string',
      description: 'Concise and clinically contextualized summary conclusion of the report.',
    },
    conclusionCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'One or more codes that represent the summary conclusion of the report.',
    },
    presentedForm: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Rich text representation of the entire result as issued by the diagnostic service.',
    },
  },
} as const

/**
 * FHIR R4 value set for `DiagnosticReport.status`: registered | partial |
 * preliminary | final | amended | corrected | appended | cancelled |
 * entered-in-error | unknown.
 */
const StatusSchema = Schema.Literal(
  'registered',
  'partial',
  'preliminary',
  'final',
  'amended',
  'corrected',
  'appended',
  'cancelled',
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

const DiagnosticReportStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('DiagnosticReport') }),
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
      basedOn: referenceArray,
      status: StatusSchema,
      category: codeableConceptArray,
      code: Schema.suspend(() => CodeableConcept.Schema),
      subject: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      ...choiceElementSetPassthroughFields(
        'effective',
        ChoiceElementSet.FhirR4SetChoices['DiagnosticReport.effective[x]']
      ),
      issued: OrNullAsOptional(Schema.DateTimeUtc),
      performer: referenceArray,
      resultsInterpreter: referenceArray,
      specimen: referenceArray,
      result: referenceArray,
      imagingStudy: referenceArray,
      media: Schema.optionalWith(mutableEncoded(Schema.Array(DiagnosticReportMedia.Schema)), {
        default: (): readonly (typeof DiagnosticReportMedia.Schema.Type)[] => [],
      }),
      conclusion: OrNullAsOptional(Schema.String),
      conclusionCode: codeableConceptArray,
      presentedForm: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Attachment.Schema))),
        { default: (): readonly (typeof Attachment.Schema.Type)[] => [] }
      ),
    })
  )
)
  .pipe(
    choiceElementSetExclusive(
      'effective',
      ChoiceElementSet.FhirR4SetChoices['DiagnosticReport.effective[x]']
    )
  )
  .annotations({ jsonSchema: diagnosticReportJsonSchema })

const DiagnosticReportSchema: Schema.Schema<
  typeof DiagnosticReportStruct.Type,
  FhirR4.DiagnosticReport,
  never
> = DiagnosticReportStruct

/** A decoded `DiagnosticReport` — the type {@link DiagnosticReportSchema} produces. */
type Type = typeof DiagnosticReportSchema.Type

export { DiagnosticReportSchema as Schema, StatusSchema }
export type { Type }
