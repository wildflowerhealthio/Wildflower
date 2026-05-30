import { Data, Duration, Effect, Option, pipe, Stream, SubscriptionRef } from 'effect'

import { authTokenRef } from './token-storage.ts'

/**
 * Standalone web has no token in `localStorage`: the user must run the
 * device-login flow. The gate redirects to the device-login route on
 * this reason.
 */
class NeedsSignIn extends Data.TaggedError('NeedsSignIn')<Record<string, never>> {}

/**
 * Embedded WebView waited the full {@link EMBEDDED_TOKEN_TIMEOUT} for
 * the host to deliver an `AuthTokenIssued` over the gatekeeper bridge
 * and it never arrived. The gate throws this to a web-side retry
 * screen — there is no host signal on timeout.
 */
class TokenTimeout extends Data.TaggedError('TokenTimeout')<Record<string, never>> {}

/** Union of the tagged rejections {@link AwaitAuthReady} fns reject with. */
type AuthReadyError = NeedsSignIn | TokenTimeout

/**
 * Public device-login route the `beforeLoad` gate redirects standalone
 * web to on {@link NeedsSignIn}. Matches the `createFileRoute` id of
 * `routes/_open/gatekeeper/device-login.tsx` (the `_open` layout
 * contributes no URL segment). Exported so the app gate redirects here
 * without re-typing the literal the slice owns.
 */
const DEVICE_LOGIN_PATH = '/gatekeeper/device-login' as const

/** How long the embedded entry waits for the host's bearer token. */
const EMBEDDED_TOKEN_TIMEOUT = Duration.seconds(5)

const isPresent = (token: string | null): token is string => token !== null && token !== ''

/**
 * Web auth-readiness logic, parameterized over the token ref so it's
 * unit-testable. Reads the ref once: present → succeed; absent →
 * `NeedsSignIn`. No waiting — a standalone browser has no host to
 * deliver a token later. See {@link awaitWebAuthReady} for the
 * singleton-bound wrapper.
 */
const webAuthReadyEffect = (
  tokenRef: SubscriptionRef.SubscriptionRef<string | null>
): Effect.Effect<void, NeedsSignIn> =>
  pipe(
    SubscriptionRef.get(tokenRef),
    Effect.flatMap((token) => (isPresent(token) ? Effect.void : Effect.fail(new NeedsSignIn({}))))
  )

/**
 * Embedded auth-readiness logic, parameterized over the token ref so
 * it's unit-testable (drive it with `TestClock` to exercise the
 * timeout). Subscribes to `tokenRef.changes` (which replays the current
 * value) and takes the first present emission, so a token that already
 * landed resolves without waiting; otherwise it waits up to
 * {@link EMBEDDED_TOKEN_TIMEOUT} before failing with {@link TokenTimeout}.
 * See {@link awaitEmbeddedAuthReady} for the singleton-bound wrapper.
 */
const embeddedAuthReadyEffect = (
  tokenRef: SubscriptionRef.SubscriptionRef<string | null>
): Effect.Effect<void, TokenTimeout> =>
  pipe(
    tokenRef.changes,
    Stream.filter(isPresent),
    Stream.runHead,
    Effect.timeoutFail({
      duration: EMBEDDED_TOKEN_TIMEOUT,
      onTimeout: () => new TokenTimeout({}),
    }),
    Effect.flatMap(
      Option.match({
        // The stream completes only on ref teardown, which doesn't
        // happen for the page's lifetime; defensive `TokenTimeout`.
        onNone: () => Effect.fail(new TokenTimeout({})),
        onSome: () => Effect.void,
      })
    )
  )

/**
 * Web (`main-web` / `main-single-web`) auth-readiness wait. Resolves
 * immediately when a token is already present (standalone web reads it
 * synchronously from `localStorage` at module load); rejects
 * immediately with {@link NeedsSignIn} otherwise, so the gate redirects
 * into the device-login flow.
 */
const awaitWebAuthReady = (): Promise<void> => Effect.runPromise(webAuthReadyEffect(authTokenRef))

/**
 * Embedded (`main-embedded`) auth-readiness wait. The host hands the
 * bearer token to the SPA over the gatekeeper bridge after
 * `transport.flushed`, so on first paint `authTokenRef` may still be
 * `null`. Awaits the ref going non-null for up to
 * {@link EMBEDDED_TOKEN_TIMEOUT}; resolves on the first present value,
 * rejects with {@link TokenTimeout} on timeout.
 */
const awaitEmbeddedAuthReady = (): Promise<void> =>
  Effect.runPromise(embeddedAuthReadyEffect(authTokenRef))

export {
  awaitEmbeddedAuthReady,
  awaitWebAuthReady,
  DEVICE_LOGIN_PATH,
  embeddedAuthReadyEffect,
  EMBEDDED_TOKEN_TIMEOUT,
  NeedsSignIn,
  TokenTimeout,
  webAuthReadyEffect,
}
export type { AuthReadyError }
