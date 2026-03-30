import { Schema } from 'effect'

import type { MaybeSourced, Sourced } from '../sourced.ts'

/**
 * Extends a resource schema so that `url` is required instead of optional.
 *
 * @typeParam A - Decoded type (must have an optional `url`)
 * @typeParam I - Encoded type
 * @typeParam R - Schema context
 * @typeParam AUrl - Decoded URL brand
 * @typeParam IUrl - Encoded URL brand
 * @param schema - The base resource schema
 * @param urlSchema - Schema for the branded URL type
 * @returns A new schema where `url` is mandatory
 */
const SchemaWithMandatorySource = <A extends MaybeSourced, I extends MaybeSourced, R>(
  schema: Schema.Schema<A, I, R>
): Schema.Schema<Sourced & A, Sourced & I, R> => {
  const mandatorySourceMeta = Schema.Struct({
    source: Schema.String,
  })
  return Schema.extend(schema, Schema.Struct({ meta: mandatorySourceMeta }))
}

export { SchemaWithMandatorySource }
