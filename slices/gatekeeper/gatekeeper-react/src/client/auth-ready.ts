import { redirect, type AnyRedirect } from '@tanstack/react-router'
import {
  Cause,
  Data,
  Duration,
  Effect,
  Option,
  pipe,
  Runtime,
  Stream,
  type Subscribable,
} from 'effect'

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
 * Reach through any `FiberFailure`-style wrapping to the underlying
 * raised value. Returns `caught` unchanged when nothing to unwrap.
 *
 * Checks both the failure channel (`Cause.failureOption` — what a
 * typed `Effect.fail(...)` rides) and the defect channel
 * (`Cause.dieOption` — what `Effect.die(...)` / unhandled throws ride)
 * so a `TokenTimeout` raised either way reaches the same branch
 * downstream. Defensive against future refactors / scope-interrupt
 * edge cases — today `embeddedAuthReadyEffect` raises `TokenTimeout`
 * on the failure channel and `webAuthReadyEffect` raises `AnyRedirect`
 * on the failure channel, so the typed-failure path is the common one,
 * but the defect path stays covered.
 *
 * `FiberFailure` stores its cause under a unique-symbol-keyed property
 * (`Runtime.FiberFailureCauseId`), not a string-named field, so the
 * `Runtime.isFiberFailure` guard is the only safe way to detect and
 * unwrap it from outside the Effect runtime.
 */
const unwrapFiberFailure = (caught: unknown): unknown => {
  if (!Runtime.isFiberFailure(caught)) return caught
  const cause = caught[Runtime.FiberFailureCauseId]
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') return failure.value
  const die = Cause.dieOption(cause)
  if (die._tag === 'Some') return die.value
  return caught
}

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
 * Web auth-readiness logic, parameterized over the token subscribable
 * so it's unit-testable. Reads via `Subscribable.get` once: present →
 * succeed; absent → fails with a TanStack `redirect` to the
 * device-login route so the app-level gate's bubble path lands the
 * user in the device flow without any intermediate `instanceof`
 * translation. No waiting — a standalone browser has no host to
 * deliver a token later. See {@link makeAwaitWebAuthReady} for the
 * factory that closes over a concrete subscribable.
 *
 * @remarks
 * The redirect is constructed (not thrown) and routed through
 * `Effect.fail`, so the failure channel carries TanStack's own
 * redirect sentinel. `Effect.runPromise` rejects with that sentinel;
 * the gate lets it bubble, which TanStack's `beforeLoad` machinery
 * interprets as a redirect. Keeping the destination literal inside
 * this module means the slice still owns the route path without
 * exporting a constant.
 */
const webAuthReadyEffect = (
  subscribable: Subscribable.Subscribable<string | null>
): Effect.Effect<void, AnyRedirect> =>
  pipe(
    // `Subscribable.Subscribable<T>` exposes `.get` as an `Effect<T>`
    // and `.changes` as a `Stream<T>` directly on the value (no
    // namespace helper). Read once for the synchronous web gate.
    subscribable.get,
    Effect.flatMap((token) =>
      isPresent(token)
        ? Effect.void
        : Effect.fail<AnyRedirect>(redirect({ to: '/gatekeeper/device-login' }))
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
  subscribable: Subscribable.Subscribable<string | null>
): Effect.Effect<void, TokenTimeout> =>
  pipe(
    subscribable.changes,
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
 * Web (`main-web` / `main-single-web`) auth-readiness factory. Closes
 * over the entry's token subscribable and returns the
 * `awaitAuthReady` function the route's `beforeLoad` calls. Resolves
 * immediately when a token is already present (standalone web reads
 * it synchronously from `localStorage` at store construction);
 * rejects with a TanStack `redirect` to the device-login route
 * otherwise. Any `FiberFailure` wrapping is unwrapped so callers see
 * the raw redirect sentinel and not a runtime shell.
 */
const makeAwaitWebAuthReady =
  (subscribable: Subscribable.Subscribable<string | null>): (() => Promise<void>) =>
  () =>
    withFiberFailureUnwrap(() => Effect.runPromise(webAuthReadyEffect(subscribable)))

/**
 * Embedded (`main-embedded`) auth-readiness factory. The host hands
 * the bearer token to the SPA over the gatekeeper bridge once the
 * page-side transport calls `transport.signalReady`, so on first
 * paint the embedded `AuthTokenStore.subscribable` is `null` AND the
 * transport may not yet be ready to even receive the host's
 * `AuthTokenIssued` message.
 *
 * Closes over the entry-supplied `subscribable` and `transportReady`
 * promise and returns the actual `awaitAuthReady` function the
 * route's `beforeLoad` calls. The returned function awaits
 * `transportReady` first (so the bridge handshake has had a chance to
 * flush the host's URL-param-encoded token messages), then waits the
 * ref going non-null for up to {@link EMBEDDED_TOKEN_TIMEOUT};
 * resolves on the first present value, rejects with
 * {@link TokenTimeout} on timeout. Any `FiberFailure` wrapping is
 * unwrapped so callers see the raw `TokenTimeout` (or a defect-routed
 * equivalent) directly.
 *
 * @param subscribable - The entry's `AuthTokenStore.subscribable`.
 * @param transportReady - Promise that resolves once the page-side
 *   `BridgeTransport` has signalled the host (`signalReady`). The
 *   factory shape is what lets the route-level gate stay
 *   environment-agnostic — `beforeLoad` only sees the resolved
 *   `() => Promise<void>` and doesn't have to know about the
 *   transport.
 */
const makeAwaitEmbeddedAuthReady =
  (
    subscribable: Subscribable.Subscribable<string | null>,
    transportReady: Promise<void>
  ): (() => Promise<void>) =>
  () =>
    withFiberFailureUnwrap(async () => {
      await transportReady
      await Effect.runPromise(embeddedAuthReadyEffect(subscribable))
    })

export {
  embeddedAuthReadyEffect,
  EMBEDDED_TOKEN_TIMEOUT,
  makeAwaitEmbeddedAuthReady,
  makeAwaitWebAuthReady,
  TokenTimeout,
  unwrapFiberFailure,
  webAuthReadyEffect,
}
