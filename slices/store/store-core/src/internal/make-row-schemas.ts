import { Schema } from 'effect'

type ColumnsRecord = Record<string, { readonly schema: Schema.Schema.AnyNoContext }>

type SchemaFields<Columns extends ColumnsRecord> = {
  readonly [K in keyof Columns]: Columns[K]['schema']
}

type OptionalIdFields<Columns extends ColumnsRecord> = {
  readonly [K in Exclude<keyof Columns, 'id'>]: Columns[K]['schema']
} & {
  id: Schema.NullOr<typeof Schema.String>
}

/**
 * Build explicit `Schema.Struct` variants for a livestore table from its
 * column definitions. Mirrors livestore's own `structSchemaForTable`
 * (see `@livestore/common/.../db-schema/dsl/mod.js`) but returns
 * `Schema.Struct<Fields>` instead of a type-erased `Schema.Schema<...>`,
 * so callers can use `.make`, `.pick`, `.omit`, `.fields`, and friends.
 *
 *  - `RowSchema` — every column, including `id`. Equivalent-by-shape to
 *    `table.rowSchema`.
 *  - `RowSchemaOptionalId` — every column except `id`; intended for flows
 *    where the client has not yet assigned an id.
 */
function makeRowSchemas<Columns extends ColumnsRecord>(
  columns: Columns,
  options: { readonly name: string }
): {
  readonly RowSchema: Schema.Struct<SchemaFields<Columns>>
  readonly RowSchemaOptionalId: Schema.Struct<OptionalIdFields<Columns>>
} {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const allFields = Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.schema])
  ) as unknown as { [K in keyof Columns]: Columns[K]['schema'] }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const withoutIdFields = Object.fromEntries(
    Object.entries(columns)
      .filter(([name]) => name !== 'id')
      .map(([name, column]) => [name, column.schema])
  ) as unknown as { [K in Exclude<keyof Columns, 'id'>]: Columns[K]['schema'] }

  const RowSchema = Schema.Struct(allFields).annotations({
    title: options.name,
  }) satisfies Schema.Struct<SchemaFields<Columns>>

  const RowSchemaOptionalId = Schema.Struct({
    ...withoutIdFields,
    id: Schema.NullOr(Schema.String),
  }).annotations({
    title: `${options.name}WithoutId`,
  }) satisfies Schema.Struct<OptionalIdFields<Columns>>

  return { RowSchema, RowSchemaOptionalId }
}

export { makeRowSchemas }
