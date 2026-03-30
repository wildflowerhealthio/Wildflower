import { Arbitrary, Schema } from 'effect'
import type { FastCheck } from 'effect'

/**
 * Annotates an array schema with a custom arbitrary generator that produces
 * either an empty array or an array whose elements satisfy `constraints`.
 *
 * The `oneof` ensures property tests exercise both the empty-array edge case
 * and arrays of varying lengths bounded by `constraints`.
 *
 * @param constraints - FastCheck array constraints (e.g. `{ minLength, maxLength }`).
 * @returns A function that accepts an array schema and returns it with the
 *          arbitrary annotation attached.
 */
export const AnnotateArrayWithArbitrary =
  (constraints: FastCheck.ArrayConstraints) =>
  <A, I, R>(schema: Schema.Array$<Schema.Schema<A, I, R>>): Schema.Array$<Schema.Schema<A, I, R>> =>
    Schema.annotations(schema, {
      arbitrary: (): Arbitrary.LazyArbitrary<readonly A[]> => (fc) =>
        fc.oneof(
          fc.constant<readonly never[]>([]),
          fc.array(Arbitrary.make<A, I, R>(schema.value), constraints)
        ),
    })
