import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'

/**
 * Validates that `timeZone` is an IANA time zone name the runtime can resolve.
 * Returns the name on success, or a `ParseError` when it is unrecognizable —
 * a user-typed value that cannot be verified is a parse failure, not a defect.
 */
const checkTimeZone = (timeZone: string): Effect.Effect<string, ParseResult.ParseError> => {
  if (Option.isSome(DateTime.zoneMakeNamed(timeZone))) return Effect.succeed(timeZone)
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

export { checkTimeZone }
