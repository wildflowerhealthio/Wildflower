import { Data, Either, Schema } from 'effect'

import * as PebbleSettings from './pebble-settings.ts'

/**
 * Where the settings page hands its result back to: the Pebble phone app's
 * `return_to`, per the Pebble "App Configuration (Static)" guide. The phone app
 * opens the page with `?return_to=<url>`; the page finishes by navigating to
 * that URL with the settings JSON, URI-encoded, appended, and the phone app
 * hands the JSON to the watchapp's `webviewclosed` handler.
 *
 * @remarks
 * A namespace module — consumers speak `ReturnTarget.Type`,
 * `ReturnTarget.decode`, `ReturnTarget.handoffUrl`.
 *
 * The settings carry a live access token, so `return_to` is an exfiltration
 * target: an arbitrary one would let anyone who can get a user to open a
 * crafted link collect a token for that user's record. So only the Pebble phone
 * app's own `pebblejs:` scheme and loopback `http(s)` (the `pebble` tool's
 * emulator configuration server) decode.
 *
 * @packageDocumentation
 */

/** The query parameter the Pebble phone app names the return URL in. */
const PARAM = 'return_to'

/** Where to return when the page was opened without `return_to` — the guide's default. */
const DEFAULT = 'pebblejs://close#'

/** Hosts a local emulator's configuration server listens on. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether `value` is the Pebble phone app or a local emulator. */
const isAllowed = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === 'pebblejs:') return true
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
}

const ReturnTargetSchema = Schema.String.pipe(
  Schema.filter(isAllowed, {
    message: () => 'return_to is neither the Pebble app nor a local emulator',
  }),
  Schema.brand('ReturnTarget')
)

type Type = typeof ReturnTargetSchema.Type

/** The page was opened with a `return_to` that is not the Pebble app or an emulator. */
class ForeignReturnTargetError extends Data.TaggedError('ForeignReturnTargetError')<{
  readonly returnTo: string
}> {}

const decodeTarget = Schema.decodeUnknownEither(ReturnTargetSchema)

/** `returnTo` as a return target, or {@link ForeignReturnTargetError} when it is not allowed. */
const decode = (returnTo: string): Either.Either<Type, ForeignReturnTargetError> =>
  Either.mapLeft(decodeTarget(returnTo), () => new ForeignReturnTargetError({ returnTo }))

/** The URL that hands `settings` back to the Pebble phone app. */
const handoffUrl = (target: Type, settings: PebbleSettings.Type): string =>
  target + encodeURIComponent(PebbleSettings.toJson(settings))

export {
  decode,
  DEFAULT,
  ForeignReturnTargetError,
  handoffUrl,
  isAllowed,
  PARAM,
  ReturnTargetSchema as Schema,
}
export type { Type }
