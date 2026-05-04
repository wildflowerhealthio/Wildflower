import { Schema } from 'effect'

export const withMandatoryId = <
  const A extends { readonly id: string | null | undefined },
  const E extends { readonly id?: string | undefined | null },
>(
  schema: Schema.Schema<A, E, never>
): Schema.Schema<Omit<A, 'id'> & { readonly id: string }, Omit<E, 'id'> & { id: string }, never> =>
  Schema.extend(Schema.omit<A, E, ['id']>('id')(schema), Schema.Struct({ id: Schema.String }))
