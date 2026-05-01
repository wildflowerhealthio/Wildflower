import { Schema } from 'effect'

import { IdSchema, TimeSchema, UriSchema } from './datatypes/primitives.ts'

/**
 * Base names of FHIR R4 data types, used in choice-element field
 */
type Name =
  | 'string'
  | 'boolean'
  | 'base64Binary'
  | 'canonical'
  | 'code'
  | 'date'
  | 'dateTime'
  | 'decimal'
  | 'id'
  | 'instant'
  | 'integer'
  | 'markdown'
  | 'oid'
  | 'positiveInt'
  | 'time'
  | 'unsignedInt'
  | 'uri'
  | 'url'
  | 'uuid'
  | 'Address'
  | 'Age'
  | 'Annotation'
  | 'Attachment'
  | 'CodeableConcept'
  | 'Coding'
  | 'ContactPoint'
  | 'Count'
  | 'Distance'
  | 'Duration'
  | 'HumanName'
  | 'Identifier'
  | 'Money'
  | 'Period'
  | 'Quantity'
  | 'Range'
  | 'Ratio'
  | 'Reference'
  | 'SampledData'
  | 'Signature'
  | 'SimpleQuantity'
  | 'Timing'
  | 'MetaDataTypes'
  | 'ContactDetail'
  | 'Contributor'
  | 'Meta'
  | 'DataRequirement'
  | 'Expression'
  | 'ParameterDefinition'
  | 'RelatedArtifact'
  | 'TriggerDefinition'
  | 'UsageContext'
  | 'Dosage'

const names = [
  'string',
  'boolean',
  'base64Binary',
  'canonical',
  'code',
  'date',
  'dateTime',
  'decimal',
  'id',
  'instant',
  'integer',
  'markdown',
  'oid',
  'positiveInt',
  'time',
  'unsignedInt',
  'uri',
  'url',
  'uuid',
  'Address',
  'Age',
  'Annotation',
  'Attachment',
  'CodeableConcept',
  'Coding',
  'ContactPoint',
  'Count',
  'Distance',
  'Duration',
  'HumanName',
  'Identifier',
  'Money',
  'Period',
  'Quantity',
  'Range',
  'Ratio',
  'Reference',
  'SampledData',
  'Signature',
  'SimpleQuantity',
  'Timing',
  'MetaDataTypes',
  'ContactDetail',
  'Contributor',
  'Meta',
  'DataRequirement',
  'Expression',
  'ParameterDefinition',
  'RelatedArtifact',
  'TriggerDefinition',
  'UsageContext',
  'Dosage',
] as const satisfies ReadonlyArray<Name>

/**
 * Schemas for every FHIR R4 primitive that has a well-defined runtime shape.
 * Pre-registered as the default thunks in the lazy registry. The static type
 * lookup that lets `ChoiceElementSet.SchemaFields` keep strict typing for
 * primitive value\[x\] fields is {@link SchemaFor} below.
 */
const baseSchemas = {
  boolean: Schema.Boolean,
  canonical: UriSchema,
  date: Schema.Date,
  dateTime: Schema.DateTimeUtc,
  decimal: Schema.Finite,
  id: IdSchema,
  integer: Schema.Int,
  string: Schema.String,
  time: TimeSchema,
  uri: UriSchema,
  url: UriSchema,
  // oxlint-disable-next-line typescript/no-explicit-any
} as const satisfies { readonly [name in Name]?: Schema.Schema<any, any, never> }

/**
 * Static schema type for a given datatype name. Primitives keep their concrete
 * schema type so consumers see e.g. `valueString: string | null` instead of
 * `unknown | null`; complex types widen to `Schema<unknown>`.
 */
type SchemaFor<TName extends Name> = TName extends keyof typeof baseSchemas
  ? (typeof baseSchemas)[TName]
  : Schema.Schema<unknown>

export { type Name, names, type SchemaFor, baseSchemas }
