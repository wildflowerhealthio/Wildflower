import { Schema } from 'effect'
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

/**
 * Decoded message union for one side of a bridge — `{[tag]: schema}`
 * record mapped to the union of its schemas' decoded types.
 *
 * @remarks
 * The sole place a decoded-type `infer` survives the refactor, so
 * `SendableMessage`, `UrlParamableMessage`, and the transport all delegate
 * their extraction here instead of repeating it.
 *
 * Two extraction steps run, both load-bearing:
 *
 * 1. The mapped type pulls each schema's decoded type via `infer A`.
 * 2. The result is re-bound through `… extends infer M extends { readonly
 *    _tag: string } ? M : never`.
 *
 * Step 2 matters because the record's value bound is
 * `Schema.Schema<any, string, never>` (the `any` absorbs `Schema`'s
 * invariance — see `README.md`). When `Of` is applied to a *concrete*
 * record the mapped type already yields the real tagged union and the
 * re-bind is the identity. But when it's applied to a *generic*
 * `Bridges[I][Dir]` (as in the transport), step 1 collapses to `any`;
 * the constrained `infer M` then pins the apparent type to
 * `{ readonly _tag: string }` rather than letting `any` leak — that's
 * what keeps `message._tag` a safe, non-`any` access in the pump and lets
 * the `callTransportReady` sender variance type-check inside generic code.
 */
type Of<R extends SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never> ? A : never
}[keyof R] extends infer M extends { readonly _tag: string }
  ? M
  : never

/**
 * Encode a decoded message to its wire string using the schema record
 * that owns its `_tag`.
 *
 * @remarks
 * A flat, transport-agnostic encode primitive: it looks up
 * `record[message._tag]` and runs `Schema.encodeSync` against it. The
 * bridge stays unaware of sending mechanics — the transport calls this
 * with the merged outbound record for the relevant side, then hands the
 * resulting string to its adapter's bare sender.
 *
 * Throws synchronously if no schema in `record` owns the message's tag —
 * a wiring error the caller is expected to have ruled out (the transport
 * checks tag ownership before calling).
 */
const stringifyMessage = (
  record: SchemaRecord,
  message: { readonly _tag: string } & Record<string, unknown>
): string => {
  const schema = record[message._tag]
  if (schema === undefined) {
    throw new Error(`[effect-messaging] stringifyMessage: no schema for tag "${message._tag}"`)
  }
  return Schema.encodeSync(schema)(message)
}

export { recordFromPairs, stringifyMessage }
export type { Of, RecordFromPairs, SchemaRecord, AnyStringEncodedSchema, ValidatedPairs }
