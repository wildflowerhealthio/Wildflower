/* oxlint-disable @typescript-eslint/no-explicit-any */

import { Schema } from 'effect'

/**
 * Creates a mutable variant of a schema's encoded representation.
 *
 * The `Type` side keeps its original (readonly) shape, but the `Encoded` side
 * becomes fully mutable. This is useful when the encoded form needs to be
 * written to a store that expects mutable objects (e.g. Firebase, FHIR).
 *
 *  Inspired by {@link Schema.mutable}
 */
export interface mutableEncoded<S extends Schema.Schema.Any> extends Schema.AnnotableClass<
  mutableEncoded<S>,
  Schema.Simplify<Schema.Schema.Type<S>>,
  Schema.SimplifyMutable<Schema.Schema.Encoded<S>>,
  Schema.Schema.Context<S>
> {}

/**
 * Wraps a schema so its encoded representation is fully mutable while its
 * type representation remains unchanged. See the {@link mutableEncoded} interface.
 *
 *  Inspired by {@link Schema.mutable}
 */
export const mutableEncoded = <S extends Schema.Schema.Any>(schema: S): mutableEncoded<S> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Schema.mutable(schema) as any
