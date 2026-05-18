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
import type { RowSchemaFromFields } from '../internal/row-schema-types.ts'
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

type RowFields = {
  readonly [K in keyof typeof columns]: (typeof columns)[K]['schema']
}

type RowSchema = RowSchemaFromFields<RowFields>

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
