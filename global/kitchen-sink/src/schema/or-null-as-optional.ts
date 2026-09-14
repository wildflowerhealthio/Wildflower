import {
  type Arbitrary,
  Effect,
  type Equivalence,
  type FastCheck,
  type ParseResult,
  Schema,
} from 'effect'

const OrNullAsOptionalWithDefault = <A, I, ADefault extends A | null>(
  innerSchema: Schema.Schema<A, I, never>,
  defaultValue: () => ADefault
): Schema.optionalWith<Schema.Schema<A | null, I | undefined>, { default: () => ADefault }> =>
  Schema.optionalWith(
    Schema.declare<null | A, undefined | I, [Schema.Schema<A, I, never>]>([innerSchema], {
      decode: (s) => {
        const decodeInner = Schema.decodeUnknown(s)
        return (input): Effect.Effect<A | null, ParseResult.ParseIssue, never> => {
          if (input == undefined) return Effect.succeed(null)
          return decodeInner(input).pipe(
            Effect.map((i) => i ?? null),
            Effect.mapError((e) => e.issue)
          )
        }
      },
      encode: (s) => {
        const encodeInner = Schema.encodeUnknown(s)
        return (input: unknown): Effect.Effect<I | undefined, ParseResult.ParseIssue, never> => {
          if (input == null) return Effect.succeed(undefined)
          return encodeInner(input).pipe(
            Effect.map((i) => i ?? undefined),
            Effect.mapError((e) => e.issue)
          )
        }
      },
    } as const).annotations({
      // Declarations have no derivable arbitrary; without this, any schema
      // embedding the combinator fails `Arbitrary.make` with MissingAnnotation.
      // Generate `null` or an inner value, honouring the inner schema's own
      // arbitrary (including any annotation it carries).
      arbitrary:
        (inner: Arbitrary.LazyArbitrary<A>): Arbitrary.LazyArbitrary<A | null> =>
        (fc: typeof FastCheck) =>
          fc.oneof(fc.constant(null), inner(fc)),
      // Same rationale for `Schema.equivalence`: without this, declarations
      // fall back to reference equality and structurally-equal values
      // compare unequal.
      equivalence:
        (inner: Equivalence.Equivalence<A>): Equivalence.Equivalence<A | null> =>
        (a, b) =>
          a === null || b === null ? a === b : inner(a, b),
    }),
    { default: defaultValue }
  )

const OrNullAsOptional = <A, I>(
  innerSchema: Schema.Schema<A, I, never>
): Schema.optionalWith<Schema.Schema<A | null, I | undefined>, { default: () => null }> =>
  OrNullAsOptionalWithDefault(innerSchema, () => null)

export { OrNullAsOptionalWithDefault, OrNullAsOptional }
