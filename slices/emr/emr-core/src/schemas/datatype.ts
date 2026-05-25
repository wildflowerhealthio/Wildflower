import { Schema } from 'effect'

import { IdSchema, InstantSchema, TimeSchema, UriSchema } from './datatypes/primitives.ts'

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
  instant: InstantSchema,
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
 * `any | null`; complex types fall back to `Schema<any, any, never>` so
 * downstream wire-format adapters (e.g. fhir-r4) can couple their concrete
 * `Schema<…, FhirR4.X, never>` assertions against this lookup until each
 * complex datatype registers a strictly-typed schema of its own.
 */
type SchemaFor<TName extends Name> = TName extends keyof typeof baseSchemas
  ? (typeof baseSchemas)[TName]
  : // oxlint-disable-next-line typescript/no-explicit-any -- See `SchemaFor` doc above; `any` lets value[x] field types stay bivariant with concrete FhirR4 datatype shapes.
    Schema.Schema<any, any, never>

/**
 * The SQLite column type a FHIR datatype lands in when persisted. Mirrors
 * the factory namespace on `State.SQLite` (`text`, `integer`, `real`,
 * `boolean`, `json`).
 */
type DbType = 'text' | 'integer' | 'real' | 'boolean' | 'json'

/**
 * Per-datatype SQLite column type used by livestore-side choice-element
 * column builders. Anything not listed here defaults to `'json'`, matching
 * how every FHIR complex datatype is persisted.
 *
 * Numeric and boolean primitives get their own native column types so
 * range queries and `WHERE` clauses work without parsing JSON; every
 * text-encoded primitive (string, code, id, date, dateTime, time,
 * uri/url/canonical, base64Binary, instant, oid, markdown, uuid) lands
 * in a `text` column.
 */
const baseDbTypes = {
  base64Binary: 'text',
  boolean: 'boolean',
  canonical: 'text',
  code: 'text',
  date: 'text',
  dateTime: 'text',
  decimal: 'real',
  id: 'text',
  instant: 'text',
  integer: 'integer',
  markdown: 'text',
  oid: 'text',
  positiveInt: 'integer',
  string: 'text',
  time: 'text',
  unsignedInt: 'integer',
  uri: 'text',
  url: 'text',
  uuid: 'text',
} as const satisfies { readonly [name in Name]?: DbType }

/**
 * Static column-type lookup that mirrors {@link SchemaFor}: primitives
 * resolve to their concrete column type (`'text'`, `'integer'`, `'boolean'`,
 * `'real'`); everything else falls back to `'json'`.
 */
type DbTypeFor<TName extends Name> = TName extends keyof typeof baseDbTypes
  ? (typeof baseDbTypes)[TName]
  : 'json'

/**
 * Encoded SQLite shape per column DbType. Boolean columns store the value
 * as an `integer` (0/1), and json columns store the value as a JSON-encoded
 * `text` string — neither matches the inner schema's encoded type, so the
 * encoded side is fixed by DbType here rather than inherited from the
 * datatype's `SchemaFor` lookup.
 */
type EncodedForDbType<TDbType extends DbType> = TDbType extends 'integer'
  ? number
  : TDbType extends 'real'
    ? number
    : TDbType extends 'boolean'
      ? number
      : string

export {
  type DbType,
  type DbTypeFor,
  type EncodedForDbType,
  type Name,
  type SchemaFor,
  baseDbTypes,
  baseSchemas,
  names,
}
