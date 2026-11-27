import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'

/**
 * Whether `timeZone` is an IANA time zone name the runtime can resolve — the
 * rule {@link checkTimeZone} applies, for a caller that needs the answer
 * rather than a failure (a form field deciding whether to report a typed
 * zone).
 */
const isKnownTimeZone = (timeZone: string): boolean =>
  Option.isSome(DateTime.zoneMakeNamed(timeZone))

/**
 * Validates that `timeZone` is an IANA time zone name the runtime can resolve.
 * Returns the name on success, or a `ParseError` when it is unrecognizable —
 * a user-typed value that cannot be verified is a parse failure, not a defect.
 */
const checkTimeZone = (timeZone: string): Effect.Effect<string, ParseResult.ParseError> => {
  if (isKnownTimeZone(timeZone)) return Effect.succeed(timeZone)
  return Effect.fail(
    new ParseResult.ParseError({
      issue: new ParseResult.Type(
        Schema.String.ast,
        timeZone,
        `"${timeZone}" is not an IANA time zone name`
      ),
    })
  )
}

export { checkTimeZone, isKnownTimeZone }
