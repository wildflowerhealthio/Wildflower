import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Coding from '../../data-types/complex/coding.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import '../../data-types/register-all.ts'
import * as ImagingStudySeries from './imaging-study-series.ts'

const imagingStudyJsonSchema = {
  type: 'object',
  title: 'ImagingStudy',
  description:
    'Representation of the content produced in a DICOM imaging study. A study comprises a set of series, each of which includes a set of Service-Object Pair Instances (SOP Instances — images or other data) acquired or produced in a common context.',
  required: ['resourceType', 'status', 'subject'],
  properties: {
    resourceType: { type: 'string', enum: ['ImagingStudy'] },
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
      description: 'Identifiers for the whole study.',
    },
    status: {
      type: 'string',
      enum: ['registered', 'available', 'cancelled', 'entered-in-error', 'unknown'],
      description: 'The current state of the ImagingStudy.',
    },
    modality: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A list of all the series.modality values that are actual acquisition modalities.',
    },
    subject: {
      type: 'object',
      description: 'The subject, typically a patient, of the imaging study.',
    },
    encounter: {
      type: 'object',
      description: 'The healthcare event during which this study was created.',
    },
    started: {
      type: 'string',
      format: 'date-time',
      description: 'Date and time the study started.',
    },
    basedOn: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A list of the diagnostic requests that resulted in this imaging study being performed.',
    },
    referrer: {
      type: 'object',
      description: 'The requesting/referring physician.',
    },
    interpreter: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who read the study and interpreted the images or other content.',
    },
    endpoint: {
      type: 'array',
      items: { type: 'object' },
      description: 'The network service providing access to these images.',
    },
    numberOfSeries: {
      type: 'integer',
      minimum: 0,
      description: 'Number of Series in the Study.',
    },
    numberOfInstances: {
      type: 'integer',
      minimum: 0,
      description: 'Number of SOP Instances in Study.',
    },
    procedureReference: {
      type: 'object',
      description: 'The procedure which this ImagingStudy was part of.',
    },
    procedureCode: {
      type: 'array',
      items: { type: 'object' },
      description: 'The code for the performed procedure type.',
    },
    location: {
      type: 'object',
      description: 'The principal physical location where the study was performed.',
    },
    reasonCode: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Description of clinical condition indicating why the ImagingStudy was requested.',
    },
    reasonReference: {
      type: 'array',
      items: { type: 'object' },
      description: 'Indicates another resource whose existence justifies this Study.',
    },
    note: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Per the recommended DICOM mapping, this element is derived from the Study Description attribute.',
    },
    description: {
      type: 'string',
      description: 'The Imaging Manager description of the study.',
    },
    series: {
      type: 'array',
      items: { type: 'object' },
      description: 'Each study has one or more series of images or other content.',
    },
  },
} as const

const StatusSchema = Schema.Literal(
  'registered',
  'available',
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

const ImagingStudyStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('ImagingStudy') }),
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
      status: StatusSchema,
      modality: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Coding.Schema))),
        { default: (): readonly (typeof Coding.Schema.Type)[] => [] }
      ),
      subject: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
      encounter: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      started: OrNullAsOptional(Schema.String),
      basedOn: referenceArray,
      referrer: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      interpreter: referenceArray,
      endpoint: referenceArray,
      numberOfSeries: OrNullAsOptional(
        Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
      ),
      numberOfInstances: OrNullAsOptional(
        Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
      ),
      procedureReference: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
      ),
      procedureCode: codeableConceptArray,
      location: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      reasonCode: codeableConceptArray,
      reasonReference: referenceArray,
      note: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.Any)), {
        default: (): readonly unknown[] => [],
      }),
      description: OrNullAsOptional(Schema.String),
      series: Schema.optionalWith(mutableEncoded(Schema.Array(ImagingStudySeries.Schema)), {
        default: (): readonly (typeof ImagingStudySeries.Schema.Type)[] => [],
      }),
    })
  )
).annotations({ jsonSchema: imagingStudyJsonSchema })

const ImagingStudySchema: Schema.Schema<
  typeof ImagingStudyStruct.Type,
  FhirR4.ImagingStudy,
  never
> = ImagingStudyStruct

export { ImagingStudySchema as Schema, StatusSchema }
