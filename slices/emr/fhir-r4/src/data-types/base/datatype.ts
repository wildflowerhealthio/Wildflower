import { Schema } from 'effect'

import { IdSchema, InstantSchema, TimeSchema, UriSchema } from './primitives.ts'

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
 * lookup that lets choice-element field builders keep strict typing for
 * primitive value\[x\] fields is {@link SchemaFor} below.
 */
const baseSchemas = {
  boolean: Schema.Boolean,
  canonical: UriSchema,
  date: Schema.Date,
  dateTime: Schema.DateTimeUtc,
  decimal: Schema.Finite,
  id: IdSchema,
  instant: InstantSchema,
  integer: Schema.Int,
  // FHIR R4 `positiveInt` is an integer strictly greater than zero, but this
  // schema deliberately accepts any integer. The registry decodes third-party
  // wire content, and a `value[x]` slot lives inside an `Extension` inside a
  // resource: rejecting `0` here fails the whole enclosing resource, which a
  // caller that unions over resource types can only observe as the resource
  // vanishing. A vendor really does send `valuePositiveInt: 0` (carebook's
  // remaining-repeats dual-write). Recorded in the Client Capabilities
  // Reference under "Unregistered choice-element datatypes".
  positiveInt: Schema.Int,
  string: Schema.String,
  time: TimeSchema,
  uri: UriSchema,
  url: UriSchema,
  // oxlint-disable-next-line typescript/no-explicit-any
} as const satisfies { readonly [name in Name]?: Schema.Schema<any, any, never> }

/**
 * Static schema type for a given datatype name. Primitives keep their concrete
 * schema type so consumers see e.g. `valueString: string | null` instead of
 * `any | null`; complex types fall back to `Schema<any, any, never>` so
 * the wire-format datatype modules can couple their concrete
 * `Schema<…, FhirR4.X, never>` assertions against this lookup until each
 * complex datatype registers a strictly-typed schema of its own.
 */
type SchemaFor<TName extends Name> = TName extends keyof typeof baseSchemas
  ? (typeof baseSchemas)[TName]
  : // oxlint-disable-next-line typescript/no-explicit-any -- See `SchemaFor` doc above; `any` lets value[x] field types stay bivariant with concrete FhirR4 datatype shapes.
    Schema.Schema<any, any, never>

export { type Name, type SchemaFor, baseSchemas, names }
