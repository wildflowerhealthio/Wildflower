import { Schema } from 'effect'

type ColumnsRecord = Record<string, { readonly schema: Schema.Schema.AnyNoContext }>

type SchemaFields<Columns extends ColumnsRecord> = {
  readonly [K in keyof Columns]: Columns[K]['schema']
}

type NullableIdFields<Columns extends ColumnsRecord> = {
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
 *  - `RowSchemaNullableId` — every column, but `id` relaxed to
 *    `NullOr(String)` so client-side flows can stage rows whose id has
 *    not yet been assigned.
 */
function makeRowSchemas<Columns extends ColumnsRecord>(
  columns: Columns,
  options: { readonly name: string }
): {
  readonly RowSchema: Schema.Struct<SchemaFields<Columns>>
  readonly RowSchemaNullableId: Schema.Struct<NullableIdFields<Columns>>
} {
  // `Object.fromEntries` is the cleanest runtime translation, but its return
  // type is `{ [k: string]: V }` — TypeScript can't preserve the per-key
  // mapping `Columns[K]['schema']` The cast is sound: every entry in `columns`
  // carries a `.schema`
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  const allFields = Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.schema])
  ) as unknown as { [K in keyof Columns]: Columns[K]['schema'] }

  const RowSchema = Schema.Struct(allFields).annotations({
    title: options.name,
  }) satisfies Schema.Struct<SchemaFields<Columns>>

  // Same `Object.fromEntries` precision-loss as `allFields` above. We could
  // spread `allFields` and override `id`, but the resulting intersection type
  // `{ [K in keyof Columns]: ... } & { id: NullOr<String> }` doesn't simplify
  // back to `NullableIdFields<Columns>` (which excludes the original `id`
  // before adding the relaxed one). The cast is sound: every entry in
  // `withoutIdFields` carries `column.schema` and `id` is added literally.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  const withoutIdFields = Object.fromEntries(
    Object.entries(columns)
      .filter(([name]) => name !== 'id')
      .map(([name, column]) => [name, column.schema])
  ) as unknown as { [K in Exclude<keyof Columns, 'id'>]: Columns[K]['schema'] }

  const RowSchemaNullableId = Schema.Struct({
    ...withoutIdFields,
    id: Schema.NullOr(Schema.String),
  }).annotations({
    title: `${options.name}NullableId`,
  }) satisfies Schema.Struct<NullableIdFields<Columns>>

  return { RowSchema, RowSchemaNullableId }
}

export { makeRowSchemas }
