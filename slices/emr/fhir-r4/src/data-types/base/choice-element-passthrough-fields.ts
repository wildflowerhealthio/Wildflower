import { Effect, ParseResult, Schema } from 'effect'
import type { LazyArg } from 'effect/Function'
import { capitalize } from 'effect/String'

import { type Datatype } from 'emr-core/schemas'
import { OrNullAsOptional, suspendWithShallowJson } from 'kitchen-sink/schema'

import { baseDatatypes, resolveDatatypeSchema } from './datatype-registry.ts'

// Per-K typed null stub. Decoded as `null`; encoded as `undefined` for null
// input, ParseResult.fail for non-null input (loud failure on encode of an
// unregistered datatype). Schema.declare's type parameters keep the encoded
// type per-K so the outer struct's per-slot encoded shape lines up without
// widening.
const nullStubFor = <K extends Datatype.Name>(
  name: K
): Schema.Schema<null, Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined, never> =>
  Schema.declare<null, Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined, never[]>([], {
    decode: () => (): Effect.Effect<null, ParseResult.ParseIssue, never> => Effect.succeed(null),
    encode:
      () =>
      (
        input,
        _options,
        ast
      ): Effect.Effect<
        Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined,
        ParseResult.ParseIssue,
        never
      > =>
        input == null
          ? Effect.succeed(undefined)
          : Effect.fail(
              new ParseResult.Type(
                ast,
                input,
                `fhir-r4 datatype "${name}" is intentionally unregistered; encoding a non-null value[x] slot for it is rejected`
              )
            ),
  })

/**
 * Builds the per-prefix `value[x]` / `effective[x]` choice fields for a FHIR
 * R4 wire-format struct. Each name in `datatypeNames` becomes an optional
 * `${prefix}${Capitalize<name>}` field. Names with a fhir-r4 wire schema
 * (`name in baseDatatypes`) resolve lazily through the registry; the rest
 * use a per-K null-stub that decodes to `null` and fails on encode of a
 * non-null value.
 */
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

  const isRegistered = (n: Datatype.Name): n is keyof typeof baseDatatypes => n in baseDatatypes

  const entries = datatypeNames.map((name) => {
    const key = `${prefix}${capitalize(name)}`
    if (isRegistered(name)) {
      const inner = suspendWithShallowJson(
        () => Effect.runSync(resolveDatatypeSchema(name)),
        `fhir-r4:${name}`
      )
      return [key, OrNullAsOptional(inner)]
    }
    return [key, Schema.optionalWith(nullStubFor(name), { default: (): null => null })]
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, unknown>; per-K Encoded typing is preserved by `nullStubFor` and `OrNullAsOptional`, so the per-key shape is recovered by construction over (prefix, name) pairs.
  return Object.fromEntries(entries) as Fields
}

export { choiceElementSetPassthroughFields }
