import { Cause, Runtime } from 'effect'

import type { RouterContext } from '../router-context.ts'

/**
 * `beforeLoad` auth gate for the owner-facing layouts (`_auth`,
 * `/settings`). Calls the injected, environment-specific
 * `context.awaitAuthReady()` and lets its rejection bubble after
 * unwrapping any `FiberFailure`-style wrapper:
 *
 *   - resolve → proceed (an authed loader below is guaranteed a token).
 *   - `redirect(...)` (standalone web, no token) → bubbles so TanStack
 *     follows the redirect into the device-login flow.
 *   - `TokenTimeout` (embedded, host never delivered the token in 5s) →
 *     bubbles so the layout's `errorComponent` renders the web-side
 *     `TokenTimeoutRetry` screen. No host signal on timeout — the user
 *     re-attempts the wait from the browser.
 *
 * Any other rejection is unexpected; bubbles too so it surfaces rather
 * than being silently swallowed into a proceed.
 *
 * @remarks
 * `awaitAuthReady()` is a `Promise` produced by `Effect.runPromise`,
 * which usually rejects with the typed `Effect.fail` value directly.
 * But for failures routed through the defect path (timeout races,
 * scope-interrupt chains around `Stream` operators) the rejection is a
 * `FiberFailure` whose `.cause` carries the real value. The gate
 * unwraps that with `Cause.failureOption` so a downstream
 * `instanceof TokenTimeout` or `isRedirect(...)` operates on the real
 * raised value, not on the `FiberFailure` shell. Without the unwrap,
 * a defect-routed `TokenTimeout` would hit the retry screen's
 * generic-error branch instead of the timeout-aware branch.
 */
const authBeforeLoad = async ({ context }: { readonly context: RouterContext }): Promise<void> => {
  try {
    await context.awaitAuthReady()
  } catch (caught: unknown) {
    throw unwrapFiberFailure(caught)
  }
}

/**
 * Reach through any `FiberFailure`-style wrapping to the underlying
 * raised value. Returns `caught` unchanged when nothing to unwrap.
 *
 * Checks both the failure channel (`Cause.failureOption` — what a
 * typed `Effect.fail(...)` rides) and the defect channel
 * (`Cause.dieOption` — what `Effect.die(...)` / unhandled throws ride)
 * so a `TokenTimeout` raised either way reaches the same branch
 * downstream.
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

export { authBeforeLoad }
