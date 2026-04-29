import { Schema, Effect, type ParseResult } from 'effect'

export const OrNullAsOptional = <A, I>(
  innerSchema: Schema.Schema<A, I, never>
): Schema.optionalWith<Schema.Schema<A | null, I | undefined>, { default: () => null }> =>
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
    } as const),
    { default: () => null }
  )
