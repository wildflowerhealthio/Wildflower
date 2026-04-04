import type { ParseResult, SchemaAST } from 'effect'
import { Arbitrary, Effect, Schema } from 'effect'

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
    arbitrary: () => Arbitrary.makeLazy(Schema.Object),
    description: 'A placeholder schema that accepts any value.',
  }
)
