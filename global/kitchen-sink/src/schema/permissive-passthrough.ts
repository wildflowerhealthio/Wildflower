import type { Arbitrary, FastCheck, ParseResult, SchemaAST } from 'effect'
import { Effect, Schema } from 'effect'

// Without this, Schema.equivalence falls back to Equal.equals on the bare
// Declaration, which is reference equality for plain objects/arrays — so a
// roundtripped value never compares equal to its original.
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}

// The `any` here is intentional for maximum compatibility on the input side —
// `Schema.declare` parameterizes the *decoded* type, and using `unknown` would
// Be overly restrictive for a pass-through placeholder. With `any`, the schema
// Accepts any encoded value and maps to `unknown` on the decoded side, so the
// `any` never leaks into consumer code and carries no type-safety risk.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export const PermissivePassthrough = Schema.declare<unknown, any, []>(
  [],
  {
    decode:
      () =>
      (
        x: unknown,
        _options: SchemaAST.ParseOptions,
        _declaration: SchemaAST.Declaration
      ): Effect.Effect<unknown, ParseResult.ParseIssue> =>
        Effect.succeed(x),
    encode:
      () =>
      (
        x: unknown,
        _options: SchemaAST.ParseOptions,
        _declaration: SchemaAST.Declaration
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      ): Effect.Effect<any, ParseResult.ParseIssue> =>
        Effect.succeed(x),
  },
  {
    // `Arbitrary.make(...)` always emits `null`. PermissivePassthrough is a
    // "TODO: register a strict schema later" placeholder; its only job is to
    // round-trip values losslessly. Random object/array generation explodes
    // property-test cost on resources that use it for choice-element columns
    // (e.g. Observation.value[x]), and the resulting shapes don't match any
    // real datatype — so callers that care about specific value variants
    // construct values explicitly anyway. Once a strict schema replaces this
    // placeholder, arbitrary inherits from there.
    arbitrary: (): Arbitrary.LazyArbitrary<unknown> => (fc: typeof FastCheck) => fc.constant(null),
    equivalence: () => deepEqual,
    description: 'A placeholder schema that accepts any value.',
    jsonSchema: {},
  }
)
