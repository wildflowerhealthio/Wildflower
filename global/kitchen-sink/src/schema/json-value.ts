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

/**
 * `JSON.stringify` collapses `-0` to `"0"`, so a `-0` anywhere in a
 * generated value breaks any round-trip property test built on top of
 * this schema (the decoded `-0` and the parsed `0` aren't structurally
 * equal). Reject samples that contain one.
 */
const containsNegativeZero = (value: JsonValue): boolean => {
  if (typeof value === 'number') return Object.is(value, -0)
  if (Array.isArray(value)) return value.some(containsNegativeZero)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsNegativeZero)
  }
  return false
}

// Arbitrary-only (test-data) exclusion, not a decode-time check:
// `JsonValue` deliberately decodes "do your best" and accepts these keys
// off the wire — only property tests trip on them, since a generated
// prototype-polluting key breaks round-trips. So they're kept out of
// generated samples, not rejected by the schema.
const unsafeKeys = ['__proto__', 'constructor', 'prototype'] as const
const containsUnsafeKeys = (value: JsonValue): boolean => {
  if (Array.isArray(value)) return value.some(containsUnsafeKeys)
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.some((key) => (unsafeKeys as readonly string[]).includes(key))) return true
    return Object.values(value).some(containsUnsafeKeys)
  }
  return false
}

const arbitraryJsonValue: LazyArbitrary<JsonValue> = (fc: typeof FastCheck) =>
  // `fc.jsonValue()` returns the same recursive union shape (mutable
  // record/array) and is structurally a `JsonValue`. Re-typing via
  // `unknown` keeps `LazyArbitrary`'s readonly variance honest at the
  // call site.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  (fc.jsonValue() as unknown as FastCheck.Arbitrary<JsonValue>).filter(
    (v) => !containsNegativeZero(v) && !containsUnsafeKeys(v)
  )

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
