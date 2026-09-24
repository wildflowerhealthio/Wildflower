import type { Subscribable } from 'effect'

import type { AuthState } from './auth-state.ts'

/**
 * The auth-readiness surface an app threads through {@link AuthStateProvider}.
 *
 * @remarks
 * Two halves on purpose:
 *
 *  - `subscribable` is the *read* side, shared by both Effect-side and
 *    React-side consumers. A `Subscribable.Subscribable<AuthState>`
 *    is the narrowest shape that supports both — anything wider (a
 *    `SubscriptionRef`, the underlying store internals) leaks Effect
 *    plumbing into every consumer without any of them needing it.
 *  - `setAuthState` is the *write* side: every sign-in, host push, or
 *    re-derive dispatches through this single seam. It carries an
 *    {@link AuthState}, not a bearer token — the signal never carries the
 *    credential (a bearer-holding page keeps its token in a separate store
 *    reader; the embedded path's stays host-side).
 *
 * Apps construct an environment-specific store and pass it in; the
 * concrete storage policies live with the app's store factories.
 */
interface AuthStateStore {
  /**
   * Live current auth-readiness {@link AuthState}. Effect consumers read
   * via `Subscribable.get`; React consumers observe `subscribable.changes`
   * for invalidation.
   */
  readonly subscribable: Subscribable.Subscribable<AuthState>
  /**
   * Publish a new auth signal. Synchronous side-effect — `subscribable.changes`
   * emits the new value before this returns to its caller.
   */
  readonly setAuthState: (signal: AuthState) => void
}

export type { AuthStateStore }
