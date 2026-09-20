/**
 * The JSON error body a failed SMART launch carries to an app's home page.
 *
 * @remarks
 * The wire is the same URL-safe-base64 JSON that the Tauri arm's launch
 * middleware uses (`slices/apps/apps-react/src/routes/_auth/home/-launch-error.ts`),
 * so a reader of either arm's `?launchError` decodes the same way. `error` is
 * the tag; the remaining fields are the diagnostics a launch failure can offer,
 * all optional because a failure rarely knows all of them.
 */
interface LaunchErrorBody {
  /** The failure tag — one of {@link LAUNCH_ERROR_MESSAGES}' keys, or any other. */
  readonly error: string
  /** The underlying failure's own message, when there was one. */
  readonly message?: string
  /** The FHIR server base (`iss`) the launch was reaching for. */
  readonly iss?: string
  /** An OAuth `error_description` from the authorization server. */
  readonly description?: string
  /** An OAuth `error_uri` from the authorization server. */
  readonly uri?: string
  /** Present on an `InsufficientScope` — the scopes the caller's token lacks. */
  readonly missingScopes?: readonly string[]
}

/** The search parameter the launch error rides on, matching the Tauri arm. */
const LAUNCH_ERROR_PARAM = 'launchError'

/**
 * Friendly opening sentence per failure tag. The concrete detail (an exception
 * message, an OAuth `error_description`) is appended after it, so the banner
 * reads as an explanation followed by evidence rather than a bare stack.
 */
const LAUNCH_ERROR_MESSAGES: Record<string, string> = {
  AuthorizeFailed: 'Could not start the SMART launch.',
  AuthorizationDenied: 'The authorization server refused the launch.',
  HandshakeFailed: 'Could not complete the SMART sign-in.',
}

/** Shown when the tag is absent or unrecognised — still better than nothing. */
const FALLBACK_LAUNCH_MESSAGE = 'The SMART launch failed.'

/**
 * URL-safe-base64 (unpadded) of the body as JSON — the `?launchError` wire.
 *
 * @remarks
 * `btoa` takes a binary string, so the JSON is UTF-8 encoded first and the bytes
 * mapped to code units one by one; a message containing non-Latin-1 text would
 * otherwise throw. The `+/=` → `-_` substitution is what makes it URL-safe.
 */
const encodeLaunchError = (body: LaunchErrorBody): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a `?launchError` parameter back to its JSON body, or `null` when it is
 * not valid URL-safe base64 carrying JSON — a hand-edited or truncated URL.
 */
const decodeLaunchError = (parameter: string): unknown => {
  try {
    const standard = parameter.replace(/-/g, '+').replace(/_/g, '/')
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value
  } catch {
    return null
  }
}

/** Read a string field off a decoded body, or `undefined` when it is absent. */
const stringField = (decoded: unknown, key: string): string | undefined => {
  if (typeof decoded !== 'object' || decoded === null || !(key in decoded)) return undefined
  const value: unknown = Reflect.get(decoded, key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The `error` tag of a decoded body, when it carries a string one. */
const launchErrorTag = (decoded: unknown): string | undefined => stringField(decoded, 'error')

/**
 * Build the {@link Error} that {@link ErrorBanner} renders for a decoded body:
 * the tag's friendly sentence followed by whatever concrete detail the failure
 * carried.
 *
 * @remarks
 * An `Error` rather than a plain string because tundraish's `formatErrorDetails`
 * returns `null` for a non-`Error`, which would drop the "Show details"
 * disclosure. The remaining diagnostics are attached as own enumerable
 * properties, which is exactly what `formatErrorDetails`' own-fields pass
 * surfaces — so `iss`, the OAuth `error_uri` and the tag land in the details
 * block where they can be read off and acted on.
 */
/**
 * The friendly sentence for a tag, or `undefined` when the tag is not one we
 * know.
 *
 * @remarks
 * The `Object.hasOwn` guard is load-bearing, not defensive dressing: the tag
 * comes from a URL, and a plain object literal's inherited keys are reachable by
 * indexing — `LAUNCH_ERROR_MESSAGES['__proto__']` returns `Object.prototype`,
 * whose truthiness would make it the headline and render the banner as
 * `[object Object]`. A property test over arbitrary tags found exactly that.
 */
const messageForTag = (tag: string): string | undefined =>
  Object.hasOwn(LAUNCH_ERROR_MESSAGES, tag) ? LAUNCH_ERROR_MESSAGES[tag] : undefined

const launchError = (decoded: unknown): Error => {
  const tag = launchErrorTag(decoded)
  const headline = (tag === undefined ? undefined : messageForTag(tag)) ?? FALLBACK_LAUNCH_MESSAGE
  const detail = stringField(decoded, 'description') ?? stringField(decoded, 'message')
  const error = new Error(detail === undefined ? headline : `${headline} ${detail}`)
  error.name = 'SmartLaunchError'
  // Diagnostics for the details disclosure. Assigned only when present so an
  // absent field does not render as an explicit `undefined`.
  const iss = stringField(decoded, 'iss')
  const uri = stringField(decoded, 'uri')
  if (tag !== undefined) Object.assign(error, { tag })
  if (iss !== undefined) Object.assign(error, { iss })
  if (uri !== undefined) Object.assign(error, { errorUri: uri })
  return error
}

/**
 * The value to hand `ErrorBanner` for the current URL's search string: an
 * {@link Error} describing the failed launch, or `null` when the search carries
 * no failure at all (the resting state, where the banner renders nothing).
 *
 * @remarks
 * Two transports land here, because a launch can fail on either side of the
 * authorization server:
 *
 * - **`?launchError=`** — our own encoded body, set by the launch page when
 *   {@link authorizeSmartLaunch} rejects before any redirect, and by the app
 *   when the token exchange fails.
 * - **`?error=`** — the OAuth-standard error return, which the authorization
 *   server itself appends to the redirect URI on a denied or expired
 *   authorization. `shouldCompleteSmartLaunch` deliberately routes these to the
 *   connect menu rather than completing a handshake that failed; reading them
 *   here is what stops that landing being silent.
 *
 * `search` is a parameter (defaulting to the live URL) so the decision can be
 * exercised without a window — the same transport-is-a-parameter style as the
 * rest of `smart/`.
 */
const launchErrorFrom = (search: string = window.location.search): Error | null => {
  const parameters = new URLSearchParams(search)

  const encoded = parameters.get(LAUNCH_ERROR_PARAM)
  if (encoded !== null && encoded !== '') return launchError(decodeLaunchError(encoded))

  const oauthError = parameters.get('error')
  if (oauthError !== null && oauthError !== '') {
    return launchError({
      error: 'AuthorizationDenied',
      message: oauthError,
      ...(parameters.get('error_description') === null
        ? {}
        : { description: parameters.get('error_description') ?? undefined }),
      ...(parameters.get('error_uri') === null
        ? {}
        : { uri: parameters.get('error_uri') ?? undefined }),
    })
  }

  return null
}

/**
 * Parameters stripped from a launch-error redirect target, because leaving them
 * on would make the app root try the very handshake that just failed.
 */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri']

/**
 * The URL to send a failed launch to: `appRoot` with the encoded body as
 * `?launchError`, preserving any other parameters `appRoot` already carries.
 *
 * @remarks
 * The app root is where the connect menu lives, so a failed launch lands
 * somewhere the user can read what went wrong and retry — rather than on the
 * launch page, which has no UI of its own beyond a "Launching…" line.
 *
 * The OAuth callback parameters are dropped from the target. That is what makes
 * the redirect safe to fire from a failed token exchange: `shouldCompleteSmartLaunch`
 * reads `code`/`state` off the URL, so carrying them to the app root would put
 * it straight back into the launched branch, fail the same single-use code
 * again, and redirect again — an infinite loop. The reason for the failure
 * survives in `?launchError`, which is the part worth keeping.
 */
const launchErrorRedirect = (appRoot: string, body: LaunchErrorBody): string => {
  const url = new URL(appRoot)
  for (const parameter of CALLBACK_PARAMS) url.searchParams.delete(parameter)
  url.searchParams.set(LAUNCH_ERROR_PARAM, encodeLaunchError(body))
  return url.href
}

/**
 * The body describing a thrown value, for the launch page's rejection handler.
 * `iss` is carried when the launch URL named one, since a discovery or CORS
 * failure is about that origin and naming it is most of the diagnosis.
 */
const launchErrorBodyFor = (
  tag: string,
  thrown: unknown,
  search: string = window.location.search
): LaunchErrorBody => {
  const iss = new URLSearchParams(search).get('iss')
  return {
    error: tag,
    message: thrown instanceof Error ? thrown.message : String(thrown),
    ...(iss === null || iss === '' ? {} : { iss }),
  }
}

export {
  FALLBACK_LAUNCH_MESSAGE,
  LAUNCH_ERROR_MESSAGES,
  LAUNCH_ERROR_PARAM,
  decodeLaunchError,
  encodeLaunchError,
  launchError,
  launchErrorBodyFor,
  launchErrorFrom,
  launchErrorRedirect,
  launchErrorTag,
  type LaunchErrorBody,
}
