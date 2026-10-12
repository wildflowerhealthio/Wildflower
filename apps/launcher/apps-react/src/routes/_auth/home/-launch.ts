import { AppsHttpApiClient } from '@wildflowerhealthio/apps-core-js/clients'
import { Schemas } from '@wildflowerhealthio/apps-core-js/http-api-definition'
import { unwrapFiberFailure } from '@wildflowerhealthio/kitchen-sink'
import { isInsufficientScopeBody } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Effect, Either, Schema } from 'effect'

import type { RunAuthed } from '../../../router-context.ts'
import { encodeLaunchError, type LaunchErrorBody } from './-launch-error.ts'

/** A launch's answer: the URL for this page to navigate to. */
type LaunchTarget = Schema.Schema.Type<typeof Schemas.LaunchTargetSchema>

/**
 * What {@link launchApp} needs to launch an app and follow the result.
 *
 * - `runAuthed`: runs the typed `POST /apps/{id}` with the owner bearer attached
 *   — the launch is scope-gated server-side, so it can't be a raw `fetch`.
 * - `navigate`: moves the tab to the launch URL the server answered with.
 *   Injected so a test can observe it.
 */
interface LaunchContext {
  readonly runAuthed: RunAuthed
  readonly navigate: (url: string) => void
}

/**
 * Launch the app `appId` through `AppsHttpApiClient.LaunchApp` and navigate to
 * the URL the launch answers with. A failure is caught and returned as an
 * encoded `?launchError` body (see {@link postLaunch}), not thrown to the
 * caller.
 *
 * Returns `right` once the page is navigating, or that body on failure, for
 * the caller to reflect into the home route's search (so the banner names the
 * missing scopes for a `403`).
 */
const launchApp = async (ctx: LaunchContext, appId: string): Promise<Either.Either<void, string>> =>
  Either.map(await postLaunch(ctx.runAuthed, appId), (target) => {
    ctx.navigate(target.url)
  })

const isAppNotFound = Schema.is(Schemas.AppNotFoundSchema)

/**
 * Classify a rejected launch into the {@link LaunchErrorBody} the home banner
 * reads. `runAuthed` rejects with a `FiberFailure`, so unwrap it first.
 */
const launchErrorBody = (error: unknown): LaunchErrorBody => {
  const cause = unwrapFiberFailure(error)
  // `LaunchApp` declares the shared `403 InsufficientScope`, so it decodes with the
  // `missingScopes` the banner names; a declared `404` decodes to `AppNotFound`.
  if (isInsufficientScopeBody(cause)) {
    return { error: 'InsufficientScope', missingScopes: cause.missingScopes }
  }
  if (isAppNotFound(cause)) return { error: 'AppNotFound' }
  return { error: 'LaunchFailed' }
}

/**
 * Run the launch: on success the launch target it answers with, else the
 * encoded launch-error body.
 */
const postLaunch = async (
  runAuthed: RunAuthed,
  id: string
): Promise<Either.Either<LaunchTarget, string>> => {
  try {
    const target = await runAuthed(
      Effect.flatMap(AppsHttpApiClient, (c) => c.apps.LaunchApp({ path: { id } }))
    )
    return Either.right(target)
  } catch (error: unknown) {
    return Either.left(encodeLaunchError(launchErrorBody(error)))
  }
}

export { launchApp }
export type { LaunchContext }
