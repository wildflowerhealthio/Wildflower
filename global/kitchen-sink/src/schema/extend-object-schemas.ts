// oxlint-disable typescript/no-unsafe-type-assertion
import { Effect, Schema } from 'effect'

// ---------------------------------------------------------------------------
// Type-level key collision detection
// ---------------------------------------------------------------------------

type KeyOverlap<A, B> = Extract<keyof A & keyof B, string>

type ExtendObjectsReturn<
  AType extends object,
  AEncoded extends object,
  AR,
  BType extends object,
  BEncoded extends object,
  BR,
> = [KeyOverlap<AType, BType>] extends [never]
  ? [KeyOverlap<AEncoded, BEncoded>] extends [never]
    ? Schema.Schema<Schema.Simplify<AType & BType>, Schema.Simplify<AEncoded & BEncoded>, AR | BR>
    : `Encoded key collision: ${KeyOverlap<AEncoded, BEncoded>}`
  : `Type key collision: ${KeyOverlap<AType, BType>}`

// ---------------------------------------------------------------------------
// ExtendObjectSchemas
// ---------------------------------------------------------------------------

/**
 * Combines two object schemas into one, like `Schema.extend`, but handles
 * combinations that `Schema.extend` cannot (e.g. a `transformOrFail` schema
 * with a struct that uses `Schema.fromKey`).
 *
 * Works by:
 * 1. Extending the encoded/type *projections* of both schemas (plain structs,
 *    so `Schema.extend` always succeeds).
 * 2. Wrapping in a single `transformOrFail` that runs both original schemas'
 *    decode/encode independently and spreads the results.
 *
 * Produces a compile-time error when the type-level or encoded-level keys
 * of the two schemas overlap.
 */
export function extendObjectSchemas<
  AType extends object,
  AEncoded extends object,
  AR,
  BType extends object,
  BEncoded extends object,
  BR,
>(
  a: Schema.Schema<AType, AEncoded, AR>,
  b: Schema.Schema<BType, BEncoded, BR>
): ExtendObjectsReturn<AType, AEncoded, AR, BType, BEncoded, BR> {
  const from = Schema.extend(Schema.encodedSchema(a), Schema.encodedSchema(b))
  const to = Schema.extend(Schema.typeSchema(a), Schema.typeSchema(b))

  return Schema.transformOrFail(from, to, {
    decode: (encoded, options) =>
      Effect.all([
        Schema.decodeUnknown(a)(encoded, {
          ...options,
          onExcessProperty: 'ignore',
        }),
        Schema.decodeUnknown(b)(encoded, {
          ...options,
          onExcessProperty: 'ignore',
        }),
      ]).pipe(
        Effect.mapError((e) => e.issue),
        Effect.map(([aResult, bResult]) => ({ ...aResult, ...bResult }))
      ),
    encode: (typed, options) =>
      Effect.all([
        Schema.encodeUnknown(a)(typed, {
          ...options,
          onExcessProperty: 'ignore',
        }),
        Schema.encodeUnknown(b)(typed, {
          ...options,
          onExcessProperty: 'ignore',
        }),
      ]).pipe(
        Effect.mapError((e) => e.issue),
        Effect.map(([aResult, bResult]) => ({ ...aResult, ...bResult }))
      ),
    strict: true,
  }) satisfies Schema.Schema<
    Schema.Simplify<AType & BType>,
    Schema.Simplify<AEncoded & BEncoded>,
    AR | BR
  > as unknown as ExtendObjectsReturn<AType, AEncoded, AR, BType, BEncoded, BR>
}
