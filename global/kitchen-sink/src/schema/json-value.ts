import { type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'

/**
 * Any JSON-safe value — the inductive closure of strings, finite
 * numbers, booleans, `null`, JSON objects (string-keyed records), and
 * JSON arrays.
 *
 * Excludes the value shapes `JSON.stringify` cannot round-trip:
 * `undefined`, `Infinity`, `NaN`, functions, `bigint`, `symbol`, and
 * any class instance with a non-default serialization.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

const arbitraryJsonValue: LazyArbitrary<JsonValue> = (fc: typeof FastCheck) =>
  // `fc.jsonValue()`'s element type is structurally compatible with our
  // `JsonValue` — both are the same recursive union — but fast-check's
  // returned shape is mutable; we narrow to the readonly form.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  fc.jsonValue() as ReturnType<typeof fc.jsonValue> & { readonly [key: string]: JsonValue }

/**
 * Schema matching any JSON-safe value. Uses `Schema.JsonNumber` for the
 * numeric branch so `Infinity`/`NaN` are rejected — those are the only
 * `number`s `JSON.stringify` cannot round-trip (it coerces both to
 * `null`).
 *
 * The schema is structurally recursive via `Schema.suspend`. A custom
 * `arbitrary` annotation delegates to `fast-check`'s built-in
 * `fc.jsonValue()` so derived property tests terminate; the default
 * `Arbitrary.make` would recurse without size control.
 *
 * Use as the value schema for any record/struct field that needs to
 * accept "opaque JSON" while preserving round-trip safety — for
 * example, a `Record({ key: Schema.String, value: JsonValue })` is a
 * lossless replacement for `Schema.Unknown` in JSON-bound contexts.
 */
const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(
  (): Schema.Schema<JsonValue> =>
    Schema.Union(
      Schema.String,
      Schema.JsonNumber,
      Schema.Boolean,
      Schema.Null,
      Schema.Record({ key: Schema.String, value: JsonValue }),
      Schema.Array(JsonValue)
    )
).annotations({
  identifier: 'JsonValue',
  description:
    'Any JSON-safe value: string, finite number, boolean, null, JSON object, or JSON array.',
  arbitrary: () => arbitraryJsonValue,
})

export { JsonValue }
