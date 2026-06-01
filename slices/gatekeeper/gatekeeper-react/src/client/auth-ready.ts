import { redirect, type AnyRedirect } from '@tanstack/react-router'
import { Data, Duration, Effect, Option, pipe, Stream, SubscriptionRef } from 'effect'

import { authTokenRef } from './token-storage.ts'

/**
 * Embedded WebView waited the full {@link EMBEDDED_TOKEN_TIMEOUT} for
 * the host to deliver an `AuthTokenIssued` over the gatekeeper bridge
 * and it never arrived. The gate throws this to a web-side retry
 * screen — there is no host signal on timeout.
 */
class TokenTimeout extends Data.TaggedError('TokenTimeout')<Record<string, never>> {}

/** How long the embedded entry waits for the host's bearer token. */
const EMBEDDED_TOKEN_TIMEOUT = Duration.seconds(5)

const isPresent = (token: string | null): token is string => token !== null && token !== ''

/**
 * Web auth-readiness logic, parameterized over the token ref so it's
 * unit-testable. Reads the ref once: present → succeed; absent →
 * fails with a TanStack `redirect` to the device-login route so the
 * app-level gate's bubble path lands the user in the device flow
 * without any intermediate `instanceof` translation. No waiting — a
 * standalone browser has no host to deliver a token later. See
 * {@link awaitWebAuthReady} for the singleton-bound wrapper.
 *
 * @remarks
 * The redirect is constructed (not thrown) and routed through
 * `Effect.fail`, so the failure channel carries TanStack's own redirect
 * sentinel. `Effect.runPromise` rejects with that sentinel; the gate
 * lets it bubble, which TanStack's `beforeLoad` machinery interprets as
 * a redirect. Keeping the destination literal inside this module means
 * the slice still owns the route path without exporting a constant.
 */
const webAuthReadyEffect = (
  tokenRef: SubscriptionRef.SubscriptionRef<string | null>
): Effect.Effect<void, AnyRedirect> =>
  pipe(
    SubscriptionRef.get(tokenRef),
    Effect.flatMap((token) =>
      isPresent(token)
        ? Effect.void
        : Effect.fail<AnyRedirect>(redirect({ to: '/gatekeeper/device-login' }))
    )
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
 * synchronously from `localStorage` at module load); rejects with a
 * TanStack `redirect` to the device-login route otherwise, which the
 * gate lets bubble so TanStack's routing machinery follows the
 * redirect.
 */
const awaitWebAuthReady = (): Promise<void> => Effect.runPromise(webAuthReadyEffect(authTokenRef))

/**
 * Embedded (`main-embedded`) auth-readiness factory. The host hands the
 * bearer token to the SPA over the gatekeeper bridge once the page-side
 * transport calls `transport.signalReady`, so on first paint
 * `authTokenRef` may still be `null` AND the transport may not yet be
 * ready to even receive the host's `AuthTokenIssued` message.
 *
 * Closes over the entry-supplied `transportReady` promise and returns
 * the actual `awaitAuthReady` function the `beforeLoad` gate calls.
 * The returned function awaits `transportReady` first (so the bridge
 * handshake has had a chance to flush the host's URL-param-encoded
 * token messages), then waits the ref going non-null for up to
 * {@link EMBEDDED_TOKEN_TIMEOUT}; resolves on the first present value,
 * rejects with {@link TokenTimeout} on timeout.
 *
 * @param transportReady - Promise that resolves once the page-side
 *   `BridgeTransport` has signalled the host (`signalReady`). The
 *   factory shape is what lets the gate stay
 *   environment-agnostic — the `_auth` `beforeLoad` only sees the
 *   resolved `() => Promise<void>` and doesn't have to know about the
 *   transport.
 */
const awaitEmbeddedAuthReady =
  (transportReady: Promise<void>): (() => Promise<void>) =>
  async () => {
    await transportReady
    return Effect.runPromise(embeddedAuthReadyEffect(authTokenRef))
  }

export {
  awaitEmbeddedAuthReady,
  awaitWebAuthReady,
  embeddedAuthReadyEffect,
  EMBEDDED_TOKEN_TIMEOUT,
  TokenTimeout,
  webAuthReadyEffect,
}
