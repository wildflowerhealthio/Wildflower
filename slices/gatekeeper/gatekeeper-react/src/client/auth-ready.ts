import { redirect, type AnyRedirect } from '@tanstack/react-router'
import { Data, Duration, Effect, Option, pipe, Stream, type Subscribable } from 'effect'
import { unwrapFiberFailure } from 'kitchen-sink'

import { type AuthState, isAuthed } from 'react-kitchen-sink'

import { buildDeviceLoginTarget } from '../device-login-route.ts'

/**
 * Embedded WebView waited the full {@link EMBEDDED_TOKEN_TIMEOUT} for
 * the host to deliver an `AuthTokenIssued` over the gatekeeper bridge
 * and it never arrived. The gate throws this to a web-side retry
 * screen — there is no host signal on timeout.
 */
class TokenTimeout extends Data.TaggedError('TokenTimeout')<Record<string, never>> {}

/** How long the embedded entry waits for the host's bearer token. */
const EMBEDDED_TOKEN_TIMEOUT = Duration.seconds(5)

/**
 * Run a `Promise<void>`-producing thunk and unwrap any
 * `FiberFailure` rejection so the downstream consumer sees the
 * underlying typed failure (`TokenTimeout`, `AnyRedirect`, etc.)
 * directly. Used by the `awaitAuthReady` factories below so callers
 * (e.g. TanStack's `beforeLoad`) don't need to re-implement the unwrap.
 */
const withFiberFailureUnwrap = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (caught: unknown) {
    throw unwrapFiberFailure(caught)
  }
}

/**
 * Auth-readiness logic for an entry whose unauthed path is the **device-login
 * route**, parameterized over the token subscribable so it's unit-testable.
 * Reads via `Subscribable.get` once: present → succeed; absent → fails with a
 * TanStack `redirect` to that route, so the app-level gate's bubble path lands
 * the user in the device flow without any intermediate `instanceof`
 * translation. No waiting — a standalone browser has no host to
 * deliver a token later. See {@link makeAwaitDeviceLoginAuthReady} for the
 * factory that closes over a concrete subscribable, and
 * {@link landingAuthReadyEffect} for the entry that sends an unauthed reader
 * to the server picker instead.
 *
 * The optional `returnTo` (the originally-requested same-origin path,
 * supplied by the gate from `location.href`) rides the redirect as a
 * `?returnTo=` search param so `NeedsAuthMessage` can send the user
 * back where they were headed once sign-in completes. Omitted when the
 * gate has no path to preserve; the consumer falls back to its default
 * destination. The raw path is sanitized at the consumer boundary
 * (`sanitizeReturnTo`), not here.
 *
 * @remarks
 * The redirect is constructed (not thrown) and routed through
 * `Effect.fail`, so the failure channel carries TanStack's own
 * redirect sentinel. `Effect.runPromise` rejects with that sentinel;
 * the gate lets it bubble, which TanStack's `beforeLoad` machinery
 * interprets as a redirect. The destination comes from the shared
 * {@link buildDeviceLoginTarget} so the gate and the app's 401 redirect
 * can't drift on the route path or the `returnTo` param.
 */
const deviceLoginAuthReadyEffect = (
  subscribable: Subscribable.Subscribable<AuthState>,
  returnTo?: string
): Effect.Effect<void, AnyRedirect> =>
  pipe(
    // `Subscribable.Subscribable<T>` exposes `.get` as an `Effect<T>`
    // and `.changes` as a `Stream<T>` directly on the value (no
    // namespace helper). Read once for the synchronous web gate.
    subscribable.get,
    Effect.flatMap((signal) =>
      isAuthed(signal)
        ? Effect.void
        : Effect.fail<AnyRedirect>(redirect(buildDeviceLoginTarget(returnTo)))
    )
  )

/**
 * Embedded auth-readiness logic, parameterized over the token
 * subscribable so it's unit-testable (drive it with `TestClock` to
 * exercise the timeout). Subscribes to `subscribable.changes` (which
 * replays the current value) and takes the first present emission, so
 * a token that already landed resolves without waiting; otherwise it
 * waits up to {@link EMBEDDED_TOKEN_TIMEOUT} before failing with
 * {@link TokenTimeout}. See {@link makeAwaitEmbeddedAuthReady} for the
 * factory that closes over the entry's subscribable and the
 * transport-ready promise.
 */
const embeddedAuthReadyEffect = (
  subscribable: Subscribable.Subscribable<AuthState>
): Effect.Effect<void, TokenTimeout> =>
  pipe(
    subscribable.changes,
    Stream.filter(isAuthed),
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
 * Device-login auth-readiness factory, used by `main-single-web` (the
 * same-origin shell the host serves). Closes over the entry's token
 * subscribable and returns the `awaitAuthReady` function the route's
 * `beforeLoad` calls. Resolves immediately when a token is already present
 * (the cookie store reads its expiry hint synchronously at construction);
 * rejects with a TanStack `redirect` to the device-login route
 * otherwise. The gate's `returnTo` (the originally-requested path)
 * rides that redirect's `?returnTo=` so sign-in returns the user
 * there. Any `FiberFailure` wrapping is unwrapped so callers see the
 * raw redirect sentinel and not a runtime shell.
 */
const makeAwaitDeviceLoginAuthReady =
  (subscribable: Subscribable.Subscribable<AuthState>): ((returnTo?: string) => Promise<void>) =>
  (returnTo) =>
    withFiberFailureUnwrap(() =>
      Effect.runPromise(deviceLoginAuthReadyEffect(subscribable, returnTo))
    )

/**
 * Embedded (`main-embedded`) auth-readiness factory. The host flips the
 * SPA's auth signal over the gatekeeper bridge once the page-side transport
 * calls `transport.signalReady`, so on first paint the embedded
 * `AuthStateStore.subscribable` is `Unauthed` AND the transport may not yet be
 * ready to even receive the host's `AuthTokenIssued` message.
 *
 * Closes over the entry-supplied `subscribable` and `transportReady`
 * promise and returns the actual `awaitAuthReady` function the
 * route's `beforeLoad` calls. The returned function awaits
 * `transportReady` first (so the bridge handshake has had a chance to
 * flush the host's URL-param-encoded token messages), then waits the
 * signal becoming authed for up to {@link EMBEDDED_TOKEN_TIMEOUT};
 * resolves on the first authed value, rejects with
 * {@link TokenTimeout} on timeout. Any `FiberFailure` wrapping is
 * unwrapped so callers see the raw `TokenTimeout` (or a defect-routed
 * equivalent) directly.
 *
 * @param subscribable - The entry's `AuthStateStore.subscribable`.
 * @param transportReady - Promise that resolves once the page-side
 *   `BridgeTransport` has signalled the host (`signalReady`). The
 *   factory shape is what lets the route-level gate stay
 *   environment-agnostic — `beforeLoad` only sees the resolved
 *   `() => Promise<void>` and doesn't have to know about the
 *   transport.
 */
const makeAwaitEmbeddedAuthReady =
  (
    subscribable: Subscribable.Subscribable<AuthState>,
    transportReady: Promise<void>
  ): (() => Promise<void>) =>
  () =>
    withFiberFailureUnwrap(async () => {
      await transportReady
      await Effect.runPromise(embeddedAuthReadyEffect(subscribable))
    })

/**
 * Auth-readiness logic for an entry whose unauthed path is the **landing page**
 * at `/`, used by `main-web` (the cross-origin build). Same synchronous
 * one-shot as {@link deviceLoginAuthReadyEffect}, but redirects to the app root
 * rather than to the device-login route: that entry picks its API server at
 * runtime, so an unauthed reader needs the server picker before any sign-in can
 * name a target.
 *
 * `returnTo` is threaded as a `?returnTo=` search param on the redirect so the
 * landing page can send the reader back where they were headed once sign-in
 * completes.
 *
 * The search is built as an **updater** over the search the reader was already
 * on, not as a fresh object: a plain object replaces the query wholesale, which
 * would drop `main-web`'s `?server=` — the one parameter the landing page needs
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
 * landing page (`/`) instead of the device-login route, preserving
 * the `returnTo` so the picker can restore it after sign-in.
 */
const makeAwaitLandingAuthReady =
  (subscribable: Subscribable.Subscribable<AuthState>): ((returnTo?: string) => Promise<void>) =>
  (returnTo) =>
    withFiberFailureUnwrap(() => Effect.runPromise(landingAuthReadyEffect(subscribable, returnTo)))

export {
  deviceLoginAuthReadyEffect,
  embeddedAuthReadyEffect,
  EMBEDDED_TOKEN_TIMEOUT,
  landingAuthReadyEffect,
  makeAwaitDeviceLoginAuthReady,
  makeAwaitEmbeddedAuthReady,
  makeAwaitLandingAuthReady,
  TokenTimeout,
}
