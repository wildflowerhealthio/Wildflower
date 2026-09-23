import {
  type Arbitrary,
  Effect,
  type Equivalence,
  type FastCheck,
  ParseResult,
  Schema,
} from 'effect'
import type { LazyArg } from 'effect/Function'
import { capitalize } from 'effect/String'

import { OrNullAsOptional, suspendWithShallowJson } from 'kitchen-sink/schema'

import { baseDatatypes, resolveDatatypeSchema } from './datatype-registry.ts'
import type * as Datatype from './datatype.ts'

// Message for encoding a non-null value into an unregistered datatype's slot.
const unregisteredEncodeMessage = (name: Datatype.Name): string =>
  `fhir-r4 datatype "${name}" is intentionally unregistered; encoding a non-null value[x] slot for it is rejected`

// Wire side of `nullStubFor`: decodes any wire content to `null`; encodes
// `null` to `undefined` and fails on non-null input. Schema.declare's type
// parameters keep the encoded type per-K so the outer struct's per-slot
// encoded shape lines up without widening.
const nullStubDeclarationFor = <K extends Datatype.Name>(
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
          : Effect.fail(new ParseResult.Type(ast, input, unregisteredEncodeMessage(name))),
  }).annotations({
    // Declarations have no derivable arbitrary or equivalence; the stub only
    // ever decodes to `null`, so generate/compare exactly that.
    arbitrary: (): Arbitrary.LazyArbitrary<null> => (fc: typeof FastCheck) => fc.constant(null),
    equivalence: (): Equivalence.Equivalence<null> => (a, b) => a === b,
  })

// Per-K typed null stub for an unregistered datatype's slot. Composed onto
// `Schema.Null` so its Type side is a strict `null` check: encoding through a
// refinement (`choiceElementSetExclusive`) first re-decodes the value against
// the Type side, and the bare declaration would map a non-null slot to `null`
// there, dropping it instead of failing.
const nullStubFor = <K extends Datatype.Name>(
  name: K
): Schema.Schema<null, Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined, never> =>
  Schema.compose(
    nullStubDeclarationFor(name),
    Schema.Null.annotations({ message: () => unregisteredEncodeMessage(name) })
  )

// True for datatype names that carry a fhir-r4 wire schema in the registry.
const isRegistered = (n: Datatype.Name): n is keyof typeof baseDatatypes => n in baseDatatypes

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

  const entries = datatypeNames.map((name) => {
    const key = `${prefix}${capitalize(name)}`
    if (isRegistered(name)) {
      // Pin `Arbitrary.make(...)` to always emit `null` on the suspend itself.
      // Property tests over resources cover the wide value-prefix space via
      // each datatype's own tests; emitting `null` here keeps generated
      // examples small and avoids re-walking ~50 datatype variants (including
      // the Reference⇄Identifier⇄Extension cycle) per property run.
      const inner = suspendWithShallowJson(
        () => Effect.runSync(resolveDatatypeSchema(name)),
        `fhir-r4:${name}`
      ).annotations({
        arbitrary: (): Arbitrary.LazyArbitrary<null> => (fc: typeof FastCheck) => fc.constant(null),
      })
      return [key, OrNullAsOptional(inner)]
    }
    return [key, Schema.optionalWith(nullStubFor(name), { default: (): null => null })]
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, unknown>; per-K Encoded typing is preserved by `nullStubFor` and `OrNullAsOptional`, so the per-key shape is recovered by construction over (prefix, name) pairs.
  return Object.fromEntries(entries) as Fields
}

/**
 * Refinement enforcing FHIR R4's at-most-one rule for a choice element: of
 * the `${prefix}${Capitalize<name>}` slots {@link choiceElementSetPassthroughFields}
 * builds for the same `(prefix, datatypeNames)`, no more than one may be
 * non-null. Pipe the containing struct through it; per-slot field types are
 * unchanged.
 *
 * @remarks
 * Decode and encode both fail with a `ParseResult.Type` issue naming every
 * populated slot. `Schema.omit` / `Schema.pick` drop the refinement — see
 * "Choice element at-most-one rule" in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const choiceElementSetExclusive =
  <const Prefix extends string, const DatatypeNames extends readonly Datatype.Name[]>(
    prefix: Prefix,
    datatypeNames: DatatypeNames
  ) =>
  <A extends ChoiceSlots<Prefix, DatatypeNames>, I, R>(
    self: Schema.Schema<A, I, R>
  ): Schema.filter<Schema.Schema<A, I, R>> => {
    const slotKeys = datatypeNames.map(
      (name: DatatypeNames[number]) => `${prefix}${capitalize(name)}` as const
    )
    return self.pipe(
      Schema.filter((value, _options, ast) => {
        const populated = slotKeys.filter((key) => value[key] != null)
        return populated.length <= 1
          ? true
          : new ParseResult.Type(
              ast,
              value,
              `choice element ${prefix}[x] allows at most one populated slot, but found ${populated.length}: ${populated.join(', ')}`
            )
      })
    )
  }

// The decoded slots a `(prefix, datatypeNames)` choice element contributes to
// a struct — the constraint `choiceElementSetExclusive` reads through.
type ChoiceSlots<Prefix extends string, DatatypeNames extends readonly Datatype.Name[]> = Readonly<
  Record<`${Prefix}${Capitalize<DatatypeNames[number]>}`, unknown>
>

export { choiceElementSetExclusive, choiceElementSetPassthroughFields }
