import type { Subscribable } from 'effect'

/**
 * The auth-token surface an app threads through {@link AuthTokenProvider}.
 *
 * @remarks
 * Two halves on purpose:
 *
 *  - `subscribable` is the *read* side, shared by both Effect-side and
 *    React-side consumers. A `Subscribable.Subscribable<string | null>`
 *    is the narrowest shape that supports both — anything wider (a
 *    `SubscriptionRef`, the underlying store internals) leaks Effect
 *    plumbing into every consumer without any of them needing it.
 *  - `setToken` is the *write* side: every token rotation, clear, or
 *    refresh dispatches through this single seam.
 *
 * Apps construct an environment-specific store and pass it in; the
 * concrete storage policies live with the app's store factories.
 */
interface AuthTokenStore {
  /**
   * Live current bearer token (or `null` when there is none). Effect
   * consumers read via `Subscribable.get`; React consumers observe
   * `subscribable.changes` for invalidation.
   */
  readonly subscribable: Subscribable.Subscribable<string | null>
  /**
   * Replace the current bearer token (or clear with `null`).
   * Synchronous side-effect — `subscribable.changes` emits the new
   * value before this returns to its caller.
   */
  readonly setToken: (token: string | null) => void
}

export type { AuthTokenStore }
