import { Schema } from 'effect'

/**
 * "JSON-encoded tagged schema" alias — the schema shape every bridge
 * carries on either side.
 *
 * @remarks
 * Effect's `Schema.Schema<A, I, R>` is **invariant** in `A`, so a
 * precise `Schema<{readonly _tag: 'X'}, string>` is *not* assignable to
 * `Schema<unknown, string>`. Using `any` for `A` exempts this internal
 * bound from the variance check; the precise type is recovered at every
 * public boundary via `infer A` (a covariant extraction position) inside
 * {@link Of}, {@link RecordFromPairs}, and {@link ValidatedPairs}'s
 * conditional. The `any` lives only inside this file.
 */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type StringEncodedSchema = Schema.Schema<any, string, never>

/** Schema describing a per-side options struct an aggregator passes when wiring a bridge. */
type OptionsShape = Schema.Schema.AnyNoContext

/**
 * Per-pair validation. Infers `Tag` from position 0 of each pair, then
 * checks the schema's *decoded* type against `{readonly _tag: Tag}`.
 * Mismatching pairs resolve to a structured error tuple so the call
 * site fails to typecheck.
 *
 * @remarks
 * Schema's invariance applies when matching `Schema<X, ...>` against
 * `Schema<Y, ...>` directly — the `infer A` form sidesteps that by
 * extracting `A` and testing it structurally.
 */
type ValidatedPairs<Pairs extends ReadonlyArray<readonly [string, StringEncodedSchema]>> = {
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
type RecordFromPairs<Pairs extends ReadonlyArray<readonly [string, StringEncodedSchema]>> = {
  readonly [P in Pairs[number] as P[0]]: P[1]
}

/** Internal value-type bound for "record of JSON-encoded tagged schemas". */
type SchemaRecord = Readonly<Record<string, StringEncodedSchema>>

/** Decoded message union for one side of a bridge. */
type Of<R extends SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never> ? A : never
}[keyof R]

/**
 * JSON-encoded routing envelope. Decoded form is `{ _tag: string }`,
 * encoded form is `string`. Used by transports / initial-message
 * peekers to extract the tag off a wire string before routing through
 * a per-bridge schema.
 */
const wireRoutingEnvelope = Schema.parseJson(Schema.Struct({ _tag: Schema.String }))

export { wireRoutingEnvelope }
export type { Of, OptionsShape, RecordFromPairs, SchemaRecord, StringEncodedSchema, ValidatedPairs }
