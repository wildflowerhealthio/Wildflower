import { Schema, SchemaAST } from 'effect'

// Wraps `target` in every refinement layer at the top of `source`, innermost
// first, so the rebuilt AST nests the filters in their original order. The
// source annotations are left behind, as `Schema.omit` leaves them behind.
const reapplyRefinements = (source: SchemaAST.AST, target: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isRefinement(source)
    ? new SchemaAST.Refinement(reapplyRefinements(source.from, target), source.filter)
    : target

/**
 * Narrows some fields of a struct schema — typically a resource or datatype
 * schema — to the given field schemas, keeping every other field as it is.
 *
 * @param schema - The schema to narrow; every key of `fields` must be one of its fields
 * @param fields - The narrower schema of each field, replacing the original
 *   one on both the decoded and the encoded side
 * @returns A schema whose type is `schema`'s with those fields replaced — so a
 *   value it decodes still fits wherever `schema`'s type does, as long as each
 *   narrowed field's type fits the original
 *
 * @remarks
 * `Schema.omit` drops refinements, so the top-level filters on `schema` (e.g.
 * the `filterForExclusiveChoiceElementSet` guards) are re-applied around the
 * result. Each filter then sees the narrowed value, which carries the same
 * fields it checks. Narrowing an already-decoded type is
 * `narrowFields(Schema.typeSchema(schema), fields)`; `withMandatoryId` is the
 * wire-side narrowing of `id` alone.
 */
const narrowFields = <A, E, const Fields extends Schema.Struct.Fields>(
  schema: Schema.Schema<A, E, never>,
  // A key `schema` does not have is typed `never`, so it cannot be passed.
  fields: Fields & { readonly [Key in Exclude<keyof Fields, keyof A & keyof E>]: never }
): Schema.Schema<
  Omit<A, keyof Fields> & Schema.Struct.Type<Fields>,
  Omit<E, keyof Fields> & Schema.Struct.Encoded<Fields>,
  Schema.Struct.Context<Fields>
> =>
  Schema.make(
    reapplyRefinements(
      schema.ast,
      Schema.extend(
        Schema.make(SchemaAST.omit(schema.ast, Object.keys(fields))),
        Schema.Struct(fields)
      ).ast
    )
  )

export { narrowFields, reapplyRefinements }
