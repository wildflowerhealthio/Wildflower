import { Schema } from 'effect'

/**
 * Type machinery describing the *messages* a bridge carries — the
 * schemas that encode/decode them, the per-pair validation a
 * `Bridge.make` declaration is checked against, and the type-level
 * record/union derivations consumers index into.
 *
 * Module is type-only (no runtime exports). Re-exported as the
 * `Message` namespace from `effect-messaging-core`'s barrel.
 */

/**
 * "JSON-encoded tagged schema" alias — the schema shape every bridge
 * carries on either side.
 *
 * Effect's `Schema.Schema<A, I, R>` is **invariant** in `A`, so a
 * precise `Schema<{readonly _tag: 'X'}, string>` is *not* assignable to
 * `Schema<unknown, string>`. Using `any` for `A` exempts this internal
 * bound from the variance check; the precise type is recovered at every
 * public boundary via `infer A` (a covariant extraction position) inside
 * {@link Of}, {@link Schemas.HandlersFor}, and {@link ValidatedPairs}'s
 * conditional.
 *
 * The `any` lives only inside this file. {@link RecordFromPairs}
 * preserves each pair's precise schema type at its key for any concrete
 * pair tuple, so user-visible types never widen to `any`.
 */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type StringEncodedSchema = Schema.Schema<any, string, never>

/**
 * Schema describing a per-side options struct an aggregator passes
 * when wiring a bridge. Aliases Effect's
 * {@link Schema.Schema.AnyNoContext} (`Schema<any, any, never>`) —
 * options aren't transmitted across the WebView boundary, so the
 * encoded form is unconstrained; consumers that want runtime
 * validation can decode through the bridge's options shape, but the
 * bridge itself doesn't require it.
 */
type OptionsShape = Schema.Schema.AnyNoContext

/**
 * Per-pair validation. The conditional infers `Tag` from position 0 of
 * each pair, then checks the schema's *decoded* type (a covariant
 * extraction position) against `{readonly _tag: Tag}`. Matching pairs
 * pass through unchanged; mismatches resolve to a structured error
 * tuple so an invalid pair fails to satisfy the input shape and
 * surfaces as a TS error at the call site.
 *
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

/**
 * Build a `{[tag]: schema}` record type from a tuple of `[tag, schema]`
 * pairs, preserving each schema's precise type at its key. The mapped
 * type distributes over the tuple's element union, so a tuple typed
 * `readonly [readonly ['Foo', typeof FooSchema], readonly ['Bar', typeof BarSchema]]`
 * becomes `{readonly Foo: typeof FooSchema; readonly Bar: typeof BarSchema}`.
 */
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
 * Tagged Message schema: anything routable across the bridge has a string
 * `_tag`. Transports decode against this first to extract the tag for
 * the unknown-tag check, then per-bridge schemas validate the full
 * payload. The two-pass approach lets the transport return a
 * structured `UnknownTag` for unowned tags while still surfacing
 * payload-shape failures as `ParseError`.
 */
const taggedMessageSchema = Schema.parseJson(Schema.Struct({ _tag: Schema.String }))

export { taggedMessageSchema }
export type { Of, OptionsShape, RecordFromPairs, SchemaRecord, StringEncodedSchema, ValidatedPairs }
