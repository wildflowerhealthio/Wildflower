import { Effect, type ParseResult, Schema } from 'effect'
import type { LazyArg } from 'effect/Function'
import { capitalize } from 'effect/String'

import { type Datatype } from 'emr-core/schemas'
import { OrNullAsOptional, suspendWithShallowJson } from 'kitchen-sink/schema'

import {
  type Name as RegisteredName,
  registeredNames,
  resolveDatatypeSchema,
} from './datatype-registry.ts'

const registeredNameSet: ReadonlySet<string> = new Set<string>(registeredNames)

const isRegisteredName = (name: Datatype.Name): name is RegisteredName =>
  registeredNameSet.has(name)

// Value for a `value[x]` slot whose fhir-r4 wire schema is intentionally not
// registered. Decoded as `null` regardless of wire content; encoded as
// `undefined` regardless of in-memory value (silently dropping any non-null
// data, since this datatype has no deliberate wire coupling). Implemented via
// `Schema.declare` to bypass the framework's strict `null` validation on
// non-null inputs — encoding is always a drop, never a parse error. Wrapped
// with `Schema.optionalWith({ default: null })` at the field call-site so the
// slot participates as a normal optional struct field.
const nullStubValue: Schema.Schema<null, unknown, never> = Schema.declare<null, unknown, never[]>(
  [],
  {
    decode: () => (): Effect.Effect<null, ParseResult.ParseIssue, never> => Effect.succeed(null),
    encode: () => (): Effect.Effect<unknown, ParseResult.ParseIssue, never> =>
      Effect.succeed(undefined),
  } as const
)

// FHIR R4 `value[x]` choice elements are emitted on the wire as optional
// `${prefix}${Capitalize<datatype>}` fields whose value is the datatype's
// encoded form, with absent fields meaning "no value". This builder reads
// from the package-local fhir-r4 datatype registry: names with a registered
// wire-format schema get a real `OrNullAsOptional` field. Names that are not
// registered get a null-stub field — the slot exists at the type level (so
// the wire schema's decoded shape still matches the store extension/resource
// type) but always decodes to `null` and never emits anything on the wire.
// That's the deliberate-couplings posture: only registered datatypes carry
// real values across the encoding boundary; everything else is intentionally
// inert.
const choiceElementSetPassthroughFields = <
  const Prefix extends string,
  const DatatypeNames extends readonly Datatype.Name[],
>(
  prefix: Prefix,
  datatypeNames: DatatypeNames
): {
  [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Schema.optionalWith<
    Schema.Schema<
      Schema.Schema.Type<Datatype.SchemaFor<K>> | null,
      Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined
    >,
    { default: LazyArg<Schema.Schema.Type<Datatype.SchemaFor<K>> | null> }
  >
} => {
  type Fields = {
    [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Schema.optionalWith<
      Schema.Schema<
        Schema.Schema.Type<Datatype.SchemaFor<K>> | null,
        Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined
      >,
      { default: LazyArg<Schema.Schema.Type<Datatype.SchemaFor<K>> | null> }
    >
  }

  const entries = datatypeNames.map((name) => {
    const key = `${prefix}${capitalize(name)}`
    if (isRegisteredName(name)) {
      // Lazy resolution lets choice fields exist on Extension/resources before
      // every complex datatype module has self-registered (Element ⇄ Extension
      // is a cycle with the complex datatypes through value[x]). By decode/encode
      // time, every registered module has loaded; if not, resolveDatatypeSchema
      // throws.
      const inner = suspendWithShallowJson(() => resolveDatatypeSchema(name), `fhir-r4:${name}`)
      return [key, OrNullAsOptional(inner)] as const
    }
    return [key, Schema.optionalWith(nullStubValue, { default: (): null => null })] as const
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, unknown>; the per-key Fields shape is recovered by construction over (prefix, name) pairs and the typed widening to `Schema.Schema.Type<Datatype.SchemaFor<K>> | null` is sound: registered slots produce real Schema<Type, Encoded> values; unregistered slots produce Schema<null, unknown> values that only emit `null` decoded — `null` is in `Type<SchemaFor<K>> | null` for every K.
  return Object.fromEntries(entries) as Fields
}

export { choiceElementSetPassthroughFields }
