import { HttpClientError } from '@effect/platform'
import { AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, Either, type Schema } from 'effect'
import { unwrapFiberFailure } from 'kitchen-sink'
import { isInsufficientScopeBody } from 'shared-structures-core/http-api-definition'

import type { AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { encodeLaunchError, launchErrorTag, type LaunchErrorBody } from './-launch-error.ts'

/** A forwarded launch's answer: the URL for this page to navigate to. */
type LaunchTarget = Schema.Schema.Type<typeof Schemas.LaunchTargetSchema>

/**
 * What {@link launchApp} needs to launch an app and follow the result.
 *
 * - `runAuthed`: runs the typed `POST /apps/{id}` with the owner bearer attached
 *   — the launch is scope-gated server-side, so it can't be a raw `fetch`.
 * - `navigate`: moves the tab to a launch URL the server answered with. Only a
 *   forwarded caller (the hosted owner UI reaching a server through its tunnel)
 *   gets one; for a loopback caller the host opened the app in a native popup and
 *   there is nowhere to go. Injected so a test can observe it.
 */
export interface LaunchContext {
  readonly runAuthed: RunAuthed
  readonly navigate: (url: string) => void
}

/**
 * Launch `app` through `AppsHttpApiClient.LaunchApp` and follow the result:
 * navigate to the URL a forwarded launch answers with, or do nothing when the host
 * opened the app itself. A failure is caught and returned as an encoded
 * `?launchError` body (see {@link postLaunch}), not thrown to the click handler.
 *
 * Returns that body on failure, for the caller to reflect into the home route's
 * search (so the banner names the missing scopes for a `403`).
 */
const launchApp = async (
  ctx: LaunchContext,
  app: AppRegistration
): Promise<Either.Either<void, string>> => {
  const launched = await postLaunch(ctx.runAuthed, app.id)
  if (Either.isRight(launched) && launched.right !== undefined) {
    ctx.navigate(launched.right.url)
    return Either.right(undefined)
  }
  return Either.map(launched, () => undefined)
}

/**
 * Classify a rejected launch into the {@link LaunchErrorBody} the home banner
 * reads. `runAuthed` rejects with a `FiberFailure`, so unwrap it first.
 */
const launchErrorBody = (error: unknown): LaunchErrorBody => {
  const cause = unwrapFiberFailure(error)
  // `LaunchApp` declares the shared `403 InsufficientScope`, so it decodes with the
  // `missingScopes` the banner names; a declared `404` decodes to `AppNotFound`; an
  // undeclared `503` arrives as a bare `ResponseError`.
  if (isInsufficientScopeBody(cause)) {
    return { error: 'InsufficientScope', missingScopes: cause.missingScopes }
  }
  if (launchErrorTag(cause) === 'AppNotFound') return { error: 'AppNotFound' }
  if (cause instanceof HttpClientError.ResponseError && cause.response.status === 503) {
    return { error: 'LaunchUnavailable' }
  }
  return { error: 'LaunchFailed' }
}

/**
 * Run the launch: on success the launch target a forwarded launch answers with
 * (`undefined` when the host opened the app), else the encoded launch-error body.
 */
const postLaunch = async (
  runAuthed: RunAuthed,
  id: string
): Promise<Either.Either<LaunchTarget | undefined, string>> => {
  try {
    const target = await runAuthed(
      Effect.flatMap(AppsHttpApiClient, (c) => c.apps.LaunchApp({ path: { id } }))
    )
    return Either.right(target ?? undefined)
  } catch (error: unknown) {
    return Either.left(encodeLaunchError(launchErrorBody(error)))
  }
}

// `LaunchContext` stays an inline `export interface` above; the functions are
// grouped here to satisfy `import/group-exports` (one export decl).
export { launchApp }
