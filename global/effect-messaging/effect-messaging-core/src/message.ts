import type { Schema } from 'effect'
import type { ReadonlyRecord } from 'effect/Record'

/**
 * "JSON-encoded tagged schema" alias — the schema shape every bridge
 * carries on either side.
 *
 * @remarks
 * `any` widens `Schema`'s invariant `A` parameter; the precise type is
 * recovered at every public boundary via `infer A`. See `README.md` for
 * the variance write-up.
 */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type AnyStringEncodedSchema = Schema.Schema<any, string, never>

/**
 * Per-pair validation. Mismatching pairs resolve to a structured error
 * tuple so the call site fails to typecheck.
 */
type ValidatedPairs<Pairs extends ReadonlyArray<readonly [string, AnyStringEncodedSchema]>> = {
  readonly [I in keyof Pairs]: Pairs[I] extends readonly [infer Tag extends string, infer S]
    ? S extends Schema.Schema<infer A, string, never>
      ? A extends { readonly _tag: Tag }
        ? Pairs[I]
        : readonly [
            'ERROR: schema decodes to a value whose _tag does not match the declared tag',
            Tag,
            A,
          ]
      : readonly ['ERROR: not a Schema with string-encoded JSON form', Tag, S]
    : never
}

/** Build a `{[tag]: schema}` record type from a tuple of `[tag, schema]` pairs. */
type RecordFromPairs<Pairs extends ReadonlyArray<readonly [string, AnyStringEncodedSchema]>> = {
  readonly [P in Pairs[number] as P[0]]: P[1]
}

/** Build a `{[tag]: schema}` record from a pair tuple. */
const recordFromPairs = <TPairs extends ReadonlyArray<readonly [string, AnyStringEncodedSchema]>>(
  pairs: TPairs
): RecordFromPairs<TPairs> => {
  const record: Record<string, AnyStringEncodedSchema> = {}
  for (const [tag, schema] of pairs) record[tag] = schema
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return record as RecordFromPairs<TPairs>
}

/** Internal value-type bound for "record of JSON-encoded tagged schemas". */
type SchemaRecord = ReadonlyRecord<string, AnyStringEncodedSchema>

/** Decoded message union for one side of a bridge. */
type Of<R extends SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never> ? A : never
}[keyof R]

export { recordFromPairs }
export type { Of, RecordFromPairs, SchemaRecord, AnyStringEncodedSchema, ValidatedPairs }
