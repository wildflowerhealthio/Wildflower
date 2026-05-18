import type { Schema } from 'effect'

/**
 * Portable derivation of a row-schema shape from a column-fields record.
 *
 * Each livestore column's `.schema` property type — per `ColDefFn` /
 * `SpecializedColDefFn` in `@livestore/common/.../field-defs.d.ts` — is
 * already a portable `Schema.Schema<TDecoded, TEncoded>` (with `| null`
 * added for `nullable: true`, and `string` substituted for the encoded
 * side when the column is a `json` column). Only the surrounding
 * `ColumnDefinition` shape pulls in `FieldColumnType` /
 * `ColumnDefaultValue` from livestore's internal `field-defs.js` subpath
 * — so a mapped type that projects every column down to its `.schema`
 * resolves to a portable field record, and wrapping it in
 * `Schema.Schema<Simplify<Struct.Type<…>>, Simplify<Struct.Encoded<…>>, never>`
 * keeps the emitted `.d.ts` self-contained.
 *
 * The bare `Schema.Schema<…, …, never>` (rather than `Schema.Struct<…>`)
 * is deliberate: it avoids both the variance gap against the runtime
 * `State.SQLite.table().rowSchema` (which isn't a `Schema.Struct`) and
 * the `Context = unknown` widening that would otherwise come from
 * `Schema.Struct`'s union-over-fields context computation.
 */
type RowSchemaFromFields<Fields extends Record<string, Schema.Schema.AnyNoContext>> = Schema.Schema<
  Schema.Simplify<Schema.Struct.Type<Fields>>,
  Schema.Simplify<Schema.Struct.Encoded<Fields>>,
  never
>

export type { RowSchemaFromFields }
