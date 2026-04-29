import { Schema } from 'effect'
import type { IndexSignature, TypeLiteral } from 'effect/Schema'
import type * as PropertySignatureNoContext from './property-signature-no-context.ts'
import type * as SchemaNoContext from './schema-no-context.ts'
/**
 * Useful for creating a type that can be used to add custom constraints to the fields of a struct.
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const f = <Fields extends Record<"a" | "b", Schema.Struct.Field>>(
 *   schema: Schema.Struct<Fields>
 * ) => {
 *   return schema.omit("a")
 * }
 *
 * //      ┌─── Schema.Struct<{ b: typeof Schema.Number; }>
 * //      ▼
 * const result = f(Schema.Struct({ a: Schema.String, b: Schema.Number }))
 * ```
 * @since 3.13.11
 */
type FieldNoContext = SchemaNoContext.AllNoContext | PropertySignatureNoContext.All

/**
 * @since 3.10.0
 */
type FieldsNoContext = { readonly [x: string]: FieldNoContext } & {
  readonly [x: number]: never
} & { readonly [x: symbol]: never }

export type { FieldNoContext, FieldsNoContext }

type RequiredKeys<T> = {
  // oxlint-disable-next-line typescript/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K
}[keyof T]

interface TypeLiteralNoContext<
  Fields extends FieldsNoContext,
  Records extends IndexSignature.Records,
> extends Schema.AnnotableClass<
  TypeLiteralNoContext<Fields, Records>,
  Schema.Simplify<TypeLiteral.Type<Fields, Records>>,
  Schema.Simplify<TypeLiteral.Encoded<Fields, Records>>,
  never
> {}

/**
 * @category api interface
 * @since 3.10.0
 */
interface StructNoContext<Fields extends FieldsNoContext> extends Schema.AnnotableClass<
  StructNoContext<Fields>,
  Schema.Simplify<Schema.Struct.Type<Fields>>,
  Schema.Simplify<Schema.Struct.Encoded<Fields>>,
  never
> {
  readonly fields: Readonly<Fields>
  readonly records: readonly []
  make(
    props: RequiredKeys<Schema.Struct.Constructor<Fields>> extends never
      ? void | Schema.Simplify<Schema.Struct.Constructor<Fields>>
      : Schema.Simplify<Schema.Struct.Constructor<Fields>>,
    options?: Schema.MakeOptions
  ): Schema.Simplify<Schema.Struct.Type<Fields>>

  annotations(
    annotations: Schema.Annotations.Schema<Schema.Simplify<Schema.Struct.Type<Fields>>>
  ): StructNoContext<Fields>
  pick<Keys extends ReadonlyArray<keyof Fields>>(
    ...keys: Keys
  ): Schema.Struct<Schema.Simplify<Pick<Fields, Keys[number]>>>
  omit<Keys extends ReadonlyArray<keyof Fields>>(
    ...keys: Keys
  ): Schema.Struct<Schema.Simplify<Omit<Fields, Keys[number]>>>
}

/**
 * @category constructors
 * @since 3.10.0
 */
function StructNoContext<
  Fields extends FieldsNoContext,
  const Records extends IndexSignature.NonEmptyRecords,
>(fields: Fields, ...records: Records): TypeLiteralNoContext<Fields, Records>
function StructNoContext<Fields extends FieldsNoContext>(fields: Fields): StructNoContext<Fields>
function StructNoContext<
  Fields extends FieldsNoContext,
  const Records extends IndexSignature.Records,
>(fields: Fields, ...records: Records): TypeLiteralNoContext<Fields, Records> {
  // @ts-expect-error
  return Schema.Struct(fields, ...records)
}

export { StructNoContext }
