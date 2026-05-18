import { State } from '@livestore/livestore'
import { Arbitrary, type FastCheck, Schema } from 'effect'

import { Base64FromUint8ArrayBuffer } from 'kitchen-sink/schema'

import {
  makeDomainResourcePersistence,
  type Events as PersistenceEvents,
  type Materializers as PersistenceMaterializers,
  type PersistenceResult,
  type Table as PersistenceTable,
} from '../internal/domain-resource-persistence.ts'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import { Code } from '../schemas/datatypes/code.ts'
import * as Reference from '../schemas/datatypes/reference.ts'
import * as DomainResource from './domain-resource.ts'

const resourceType = 'Binary' as const

const columns = {
  ...DomainResource.columns,
  resourceType: State.SQLite.text({
    default: resourceType,
    schema: Schema.Literal(resourceType),
  }),
  id: State.SQLite.text({ primaryKey: true }),
  contentType: State.SQLite.text({ schema: Code }),
  data: State.SQLite.blob({
    nullable: true,
    schema: Base64FromUint8ArrayBuffer,
  }),
  securityContext: State.SQLite.json({
    nullable: true,
    schema: Reference.Schema,
  }),
} as const

// ---------------------------------------------------------------------------
// Portable derivation of the row-schema shape.
//
// Each livestore column's `.schema` property type — per `ColDefFn` /
// `SpecializedColDefFn` in `@livestore/common/.../field-defs.d.ts` — is
// already a portable `Schema.Schema<TDecoded, TEncoded>` (with `| null`
// added for `nullable: true`, and `string` substituted for the encoded
// side when the column is a `json` column). Only the surrounding
// `ColumnDefinition` shape pulls in `FieldColumnType` /
// `ColumnDefaultValue` from livestore's internal `field-defs.js` subpath
// — so a mapped type that projects every column down to its `.schema`
// resolves to a portable field record with no manual schema spelling.
// ---------------------------------------------------------------------------

type RowFields = {
  readonly [K in keyof typeof columns]: (typeof columns)[K]['schema']
}

// `RowSchema` is the portable shape `PersistenceTable` etc. parameterize
// over. Using a plain `Schema.Schema<…, …, never>` here (rather than a
// `Schema.Struct<RowFields>`) avoids both the variance gap against the
// runtime `State.SQLite.table().rowSchema` (which isn't a `Schema.Struct`)
// and the `Context = unknown` widening that would otherwise come from
// `Schema.Struct`'s union-over-fields context computation.
type RowSchema = Schema.Schema<
  Schema.Simplify<Schema.Struct.Type<RowFields>>,
  Schema.Simplify<Schema.Struct.Encoded<RowFields>>,
  never
>

type NullableIdFields = Omit<RowFields, 'id'> & {
  readonly id: Schema.NullOr<typeof Schema.String>
}
type RowSchemaNullableId = Schema.Schema<
  Schema.Simplify<Schema.Struct.Type<NullableIdFields>>,
  Schema.Simplify<Schema.Struct.Encoded<NullableIdFields>>,
  never
>

type Table = PersistenceTable<typeof resourceType, RowSchema>
type Events = PersistenceEvents<typeof resourceType, RowSchema>
type Materializers = PersistenceMaterializers<typeof resourceType, RowSchema>
type Queries = PersistenceResult<typeof resourceType, RowSchema, RowSchema>['queries']

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const table: Table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema: BaseRowSchema, RowSchemaNullableId } = makeRowSchemas(columns, {
  name: resourceType,
})

// Normalize the `data` column's arbitrary values through the base64 encode
// of a freshly-generated `Uint8Array`, so property tests round-trip without
// tripping over strings that don't decode.
const RowSchema = BaseRowSchema.annotations({
  arbitrary: () => (fc: typeof FastCheck) =>
    Arbitrary.make(BaseRowSchema).chain((binary) =>
      fc.uint8Array().map((data) => ({
        ...binary,
        data: Schema.encodeSync(Schema.Uint8ArrayFromBase64)(data),
      }))
    ),
})

const {
  events,
  materializers,
  queries,
}: {
  events: Events
  materializers: Materializers
  queries: Queries
} = makeDomainResourcePersistence({
  table,
  rowSchema: RowSchema,
})

export { events, materializers, queries, resourceType, RowSchema, RowSchemaNullableId, table }
export type { Events, Materializers, Queries, RowFields, Table }
