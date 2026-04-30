import type { Option } from 'effect'
import { Schema } from 'effect'
import { capitalize, uncapitalize } from 'effect/String'

import type { ReadonlyRecord } from 'effect/Record'
import { type Datatype, type DatatypeName, baseDatatypes } from './datatype.ts'

/**
 * Builds a `Schema.Struct` of flat, prefix-namespaced optional fields for a
 * FHIR `value[x]`-style choice element. Each data type name becomes a single
 * optional field whose name is `${prefix}${Capitalize<name>}`.
 *
 * No mutual exclusion is enforced at the schema level — any combination of
 * the generated fields may be present in a decoded or encoded value. Callers
 * that need "exactly one" semantics must layer that on themselves.
 *
 * @example
 * ```typescript
 * const Value = DatatypeChoice('value', ['string', 'boolean', 'Quantity'])
 * // Schema fields: { valueString?: string, valueBoolean?: boolean, valueQuantity?: ... }
 *
 * // Spread into a resource:
 * const Observation = Schema.Struct({ code: CodeableConcept.Schema, ...Value.fields })
 * ```
 *
 * @param prefix - Prefix for each generated field (e.g. `'value'`, `'effective'`)
 * @param datatypeNames - Array of data type names to include in the choice
 * @param overrideFields - Optional array of {@link Datatype} overrides for specific names
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- return type depends on computed local types and cannot be expressed externally
function DatatypeChoice<
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `Prefix` is consumed by the local `Fields` type to build template-literal property names; the lint rule only inspects the outer signature.
  const Prefix extends string,
  const DatatypeNames extends readonly DatatypeName[],
  // oxlint-disable-next-line typescript/no-explicit-any
  const Overrides extends readonly Datatype<DatatypeNames[number], any, any>[] = [],
>(prefix: Prefix, datatypeNames: DatatypeNames, overrideFields?: Overrides) {
  type Fields = {
    [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Schema.NullOr<
      K extends Overrides[number]['name']
        ? Extract<Overrides[number], { name: K }>['schema']
        : (typeof baseDatatypes)[K]['schema']
    >
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fields = Object.fromEntries(
    datatypeNames.map((name) => {
      const schema =
        overrideFields?.find((o) => o.name === name)?.schema ?? baseDatatypes[name].schema
      return [`${prefix}${capitalize(name)}`, Schema.NullOr(schema)]
    })
  ) as Schema.Simplify<Fields>

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const empty = Object.fromEntries(
    datatypeNames.map((name) => [`${prefix}${capitalize(name)}`, null])
    // oxlint-disable-next-line typescript/no-explicit-any
  ) as unknown as { [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Option.None<any> }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const emptyEncoded = Object.fromEntries(
    datatypeNames.map((name) => [`${prefix}${capitalize(name)}`, null])
  ) as unknown as { [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: null }

  return { fields, empty, emptyEncoded }
}

// ---------------------------------------------------------------------------
// DatatypeChoice utilities — `cases` and `match`
// ---------------------------------------------------------------------------

/** Strip a literal `Prefix` off a key and uncapitalize the remainder. */
type Unprefix<K, Prefix extends string> = K extends `${Prefix}${infer Rest}`
  ? Uncapitalize<Rest>
  : never

/** Rebuild the flat key for a given un-prefixed datatype name. */
type Prefixed<Name extends string, Prefix extends string> = `${Prefix}${Capitalize<Name>}`

/** Object keyed by un-prefixed datatype names, carrying whatever the flat field carried. */
type Cases<Prefix extends string, T> = {
  readonly [K in keyof T as Unprefix<K, Prefix>]: T[K]
}

/**
 * Decompose a flat choice value into an object keyed by the un-prefixed
 * datatype names. Keys whose underlying field is `undefined` stay
 * `undefined` in the result.
 *
 * @example
 * ```typescript
 * const v = { valueString: 'hi' } as const
 * const { string, boolean } = DatatypeChoice.cases('value', v)
 * // string: 'hi'; boolean: undefined
 * ```
 */
// oxlint-disable-next-line typescript/no-explicit-any
function cases<const Prefix extends string, T extends ReadonlyRecord<string, any>>(
  prefix: Prefix,
  value: T | undefined
): Cases<Prefix, T> {
  const result: Record<string, unknown> = {}
  if (value !== undefined && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k.length > prefix.length && k.startsWith(prefix)) {
        result[uncapitalize(k.slice(prefix.length))] = v
      }
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result as Cases<Prefix, T>
}

/** Inner value type for a given un-prefixed datatype name on a flat object. */
type ValueFor<T, Prefix extends string, Name extends string> =
  Prefixed<Name, Prefix> extends keyof T ? Exclude<T[Prefixed<Name, Prefix>], undefined> : never

type ExhaustiveMatchers<Prefix extends string, T, R> = {
  readonly [Name in Unprefix<keyof T, Prefix> & string]-?: (value: ValueFor<T, Prefix, Name>) => R
}

type PartialMatchers<Prefix extends string, T, R> = {
  readonly [Name in Unprefix<keyof T, Prefix> & string]?: (
    value: ValueFor<T, Prefix, Name>
  ) => R | undefined
}

/**
 * Pattern-match on a flat choice value. The matchers object is keyed by
 * un-prefixed datatype names; the handler for a key receives the value of
 * `value[${prefix}${Capitalize<key>}]`.
 *
 * Matchers are tried in insertion order — the first one whose flat field is
 * defined on `value` wins. Without a default, the matchers must be
 * exhaustive for the schema's datatype names.
 *
 * @example
 * ```typescript
 * const label = DatatypeChoice.match('value', obs, {
 *   string: (s) => s,
 *   boolean: (b) => b ? 'Yes' : 'No',
 *   Quantity: (q) => String(q.value),
 * })
 * ```
 */
// oxlint-disable-next-line typescript/no-explicit-any
function match<const Prefix extends string, T extends ReadonlyRecord<string, any>, R>(
  prefix: Prefix,
  value: T,
  matchers: ExhaustiveMatchers<Prefix, T, R>
): R
// oxlint-disable-next-line typescript/no-explicit-any
function match<const Prefix extends string, T extends ReadonlyRecord<string, any>, R>(
  prefix: Prefix,
  value: T,
  matchers: PartialMatchers<Prefix, T, R>,
  defaultFn: (unmatched: T) => R
): R
// oxlint-disable-next-line typescript/no-explicit-any
function match<const Prefix extends string, T extends ReadonlyRecord<string, any>, R>(
  prefix: Prefix,
  value: T,
  matchers: PartialMatchers<Prefix, T, R>,
  defaultFn?: (unmatched: T) => R
): R {
  for (const [name, matcher] of Object.entries(matchers)) {
    if (!matcher) continue
    const flatKey = `${prefix}${capitalize(name)}`
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const fieldValue = value[flatKey]
    if (fieldValue !== null) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- matcher is a typed callable derived from ExhaustiveMatchers/PartialMatchers; the per-key type is lost when iterating Object.entries
      return (matcher as (v: unknown) => R)(fieldValue)
    }
  }
  if (defaultFn) return defaultFn(value)
  throw new Error(
    `DatatypeChoice.match: no matcher handled a defined field on prefix "${prefix}" and no default provided`
  )
}

export { DatatypeChoice, cases, match }

export type { Cases, ExhaustiveMatchers, PartialMatchers, Unprefix, ValueFor }
