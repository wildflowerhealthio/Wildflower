import { Option, Schema } from 'effect'
import { InsufficientScopeSchema } from 'shared-structures-core/http-api-definition'

/**
 * A launch failure the home screen names with its own sentence; a scope error
 * renders the `AuthorizationFailure` surface instead (see
 * {@link launchBannerError}).
 */
const KnownLaunchError = Schema.Struct({
  error: Schema.Literal('AppNotFound', 'LaunchUnavailable'),
})

/** Friendly sentence per {@link KnownLaunchError} tag. */
const LAUNCH_ERROR_MESSAGES: Record<Schema.Schema.Type<typeof KnownLaunchError>['error'], string> =
  {
    AppNotFound: 'That app is no longer available.',
    LaunchUnavailable: 'That app can’t be reached right now. Try again in a moment.',
  }
const FALLBACK_LAUNCH_MESSAGE = 'That app couldn’t be launched.'

const isKnownLaunchError = Schema.is(KnownLaunchError)
const isInsufficientScope = Schema.is(InsufficientScopeSchema)

/**
 * The JSON error body a launch failure carries to the home screen through
 * `?launchError` — an `InsufficientScope` naming the missing scopes, an
 * `AppNotFound`, a `LaunchUnavailable` — built from the typed client's decoded
 * error (see `-launch.ts`).
 */
const LaunchErrorBody = Schema.Union(
  InsufficientScopeSchema,
  KnownLaunchError,
  Schema.Struct({ error: Schema.String })
)
type LaunchErrorBody = Schema.Schema.Type<typeof LaunchErrorBody>

/** The `?launchError` wire: URL-safe base64 (unpadded) of the body as UTF-8 JSON. */
const LaunchErrorParameter = Schema.compose(
  Schema.StringFromBase64Url,
  Schema.parseJson(LaunchErrorBody)
)

/** The body as the `?launchError` parameter value. */
const encodeLaunchError: (body: LaunchErrorBody) => string = Schema.encodeSync(LaunchErrorParameter)

const decodeLaunchError = Schema.decodeUnknownOption(LaunchErrorParameter)

/**
 * The value to hand `ErrorBanner` for a `?launchError` search param: the decoded
 * `InsufficientScope` body (so the app's ambient error renderer shows the
 * `AuthorizationFailure` surface, naming the missing scopes), a friendly message
 * string for any other launch failure, or `null` when there's no param.
 */
const launchBannerError = (param: string | undefined): unknown => {
  if (param === undefined || param === '') return null
  const body = Option.getOrUndefined(decodeLaunchError(param))
  if (isInsufficientScope(body)) return body
  if (isKnownLaunchError(body)) return LAUNCH_ERROR_MESSAGES[body.error]
  return FALLBACK_LAUNCH_MESSAGE
}

export { encodeLaunchError, launchBannerError, type LaunchErrorBody }
