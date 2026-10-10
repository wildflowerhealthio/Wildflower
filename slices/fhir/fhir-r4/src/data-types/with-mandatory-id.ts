import { Schema } from 'effect'

import { reapplyRefinements } from './narrow-fields.ts'

/**
 * Narrows a resource schema's `id` from optional to a required `string`, on
 * both the decoded and the wire side.
 *
 * @remarks
 * `Schema.omit` drops refinements, so the top-level filters on `schema` (e.g.
 * the `filterForExclusiveChoiceElementSet` guards) are re-applied around the result.
 * Each filter then sees the narrowed value, which carries the same fields it
 * checks — `id` is the only field whose type changes.
 */
export const withMandatoryId = <
  const A extends { readonly id: string | null | undefined },
  const E extends { readonly id?: string | undefined | null },
>(
  schema: Schema.Schema<A, E, never>
): Schema.Schema<Omit<A, 'id'> & { readonly id: string }, Omit<E, 'id'> & { id: string }, never> =>
  Schema.make(
    reapplyRefinements(
      schema.ast,
      Schema.extend(Schema.omit<A, E, ['id']>('id')(schema), Schema.Struct({ id: Schema.String }))
        .ast
    )
  )
