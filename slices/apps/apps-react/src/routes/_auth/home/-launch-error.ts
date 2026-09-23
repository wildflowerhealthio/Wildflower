import { isInsufficientScopeBody } from 'shared-structures-core/http-api-definition'

/**
 * The JSON error body a launch failure carries to the home screen through
 * `?launchError` — an `InsufficientScope` naming the missing scopes, an
 * `AppNotFound`, a `LaunchUnavailable` — built from the typed client's decoded
 * error (see `-launch.ts`).
 */
interface LaunchErrorBody {
  readonly error: string
  /** Present on `InsufficientScope` — the scopes the caller's token lacks. */
  readonly missingScopes?: readonly string[]
}

/** Friendly sentence per non-scope launch-error tag; a scope error renders the
 * `AuthorizationFailure` surface instead (see {@link launchBannerError}). */
const LAUNCH_ERROR_MESSAGES: Record<string, string> = {
  AppNotFound: 'That app is no longer available.',
  LaunchUnavailable: 'That app can’t be reached right now. Try again in a moment.',
}
const FALLBACK_LAUNCH_MESSAGE = 'That app couldn’t be launched.'

/** URL-safe-base64 (unpadded) of a JSON value — the `?launchError` wire, matching
 * the Rust launch middleware so both arms encode identically. */
const encodeLaunchError = (body: LaunchErrorBody): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a `?launchError` param back to its JSON error body, or `null` when it
 * isn't valid URL-safe base64 + JSON (e.g. a hand-edited URL). */
const decodeLaunchError = (param: string): unknown => {
  try {
    const standard = param.replace(/-/g, '+').replace(/_/g, '/')
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value
  } catch {
    return null
  }
}

/** The `error` tag of a decoded body, when it carries a string one. */
const launchErrorTag = (decoded: unknown): string | undefined => {
  if (typeof decoded !== 'object' || decoded === null || !('error' in decoded)) return undefined
  const { error } = decoded
  return typeof error === 'string' ? error : undefined
}

/**
 * The value to hand `ErrorBanner` for a `?launchError` search param: the decoded
 * `InsufficientScope` body (so the app's ambient error renderer shows the
 * `AuthorizationFailure` surface, naming the missing scopes), a friendly message
 * string for any other launch failure, or `null` when there's no param.
 */
const launchBannerError = (param: string | undefined): unknown => {
  if (param === undefined || param === '') return null
  const decoded = decodeLaunchError(param)
  if (isInsufficientScopeBody(decoded)) return decoded
  const tag = launchErrorTag(decoded)
  return (tag === undefined ? undefined : LAUNCH_ERROR_MESSAGES[tag]) ?? FALLBACK_LAUNCH_MESSAGE
}

export { encodeLaunchError, launchBannerError, launchErrorTag, type LaunchErrorBody }
