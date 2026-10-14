import { redirect, type AnyRedirect } from '@tanstack/react-router'
import { unwrapFiberFailure } from '@wildflowerhealthio/kitchen-sink'
import { Effect, pipe, type Subscribable } from 'effect'

import { type AuthState, isAuthed } from '@wildflowerhealthio/react-kitchen-sink'

/**
 * Run a `Promise<void>`-producing thunk and unwrap any
 * `FiberFailure` rejection so the downstream consumer sees the
 * underlying typed failure (an `AnyRedirect`) directly. Used by
 * {@link makeAwaitLandingAuthReady} so callers (e.g. TanStack's
 * `beforeLoad`) don't need to re-implement the unwrap.
 */
const withFiberFailureUnwrap = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (caught: unknown) {
    throw unwrapFiberFailure(caught)
  }
}

/**
 * Auth-readiness logic for the launcher, whose unauthed path is the **landing
 * page** at `/`, parameterized over the token subscribable so it's
 * unit-testable. Reads via `Subscribable.get` once:
 * present → succeed; absent → fails with a TanStack `redirect` to the app root.
 * No waiting — nothing delivers a token later. The redirect targets the landing
 * page because the launcher picks its API server at runtime, so an unauthed
 * reader needs the server picker before any sign-in can name a target.
 *
 * `returnTo` is threaded as a `?returnTo=` search param on the redirect so the
 * landing page can send the reader back where they were headed once sign-in
 * completes.
 *
 * The search is built as an **updater** over the search the reader was already
 * on, not as a fresh object: a plain object replaces the query wholesale, which
 * would drop the launcher's `?server=` — the one parameter the landing page needs
 * to offer a way back in. A reader whose in-memory bearer is gone (any reload)
 * would otherwise land on a picker with nothing picked and have to retype their
 * server.
 */
const landingAuthReadyEffect = (
  subscribable: Subscribable.Subscribable<AuthState>,
  returnTo?: string
): Effect.Effect<void, AnyRedirect> =>
  pipe(
    subscribable.get,
    Effect.flatMap((signal) => {
      if (isAuthed(signal)) return Effect.void
      return Effect.fail<AnyRedirect>(
        redirect({
          to: '/',
          search: (previous: Record<string, unknown>) => ({
            ...previous,
            ...(returnTo !== undefined && returnTo !== '' ? { returnTo } : {}),
          }),
        })
      )
    })
  )

/**
 * Landing-page auth-readiness factory. Closes over the entry's token
 * subscribable and returns the `awaitAuthReady` function the
 * route's `beforeLoad` calls. Redirects unauthed users to the
 * landing page (`/`), preserving the `returnTo` so the picker can
 * restore it after sign-in.
 */
const makeAwaitLandingAuthReady =
  (subscribable: Subscribable.Subscribable<AuthState>): ((returnTo?: string) => Promise<void>) =>
  (returnTo) =>
    withFiberFailureUnwrap(() => Effect.runPromise(landingAuthReadyEffect(subscribable, returnTo)))

export { landingAuthReadyEffect, makeAwaitLandingAuthReady }
