import type { Subscribable } from 'effect'

/**
 * The auth-token surface an app threads through {@link AuthTokenProvider}.
 *
 * @remarks
 * Two halves on purpose:
 *
 *  - `subscribable` is the *read* side. Both Effect-side consumers
 *    (e.g. a `BearerToken` Layer feeding `HttpClient.mapRequestEffect`)
 *    and React-side consumers (e.g. TanStack-Query invalidators
 *    subscribed to `subscribable.changes`) read through the same
 *    surface. A `Subscribable.Subscribable<string | null>` is the
 *    narrowest shape that supports both — anything wider (a
 *    `SubscriptionRef`, the underlying store internals) leaks Effect
 *    plumbing into every consumer without any of them needing it.
 *  - `setToken` is the *write* side. The gatekeeper page-bridge
 *    handler, the device-login completion, and any future
 *    sign-out / refresh path all dispatch through this single seam.
 *
 * Per-entry implementations construct concrete stores in their
 * `main-*` entrypoint and pass them into `renderApp`'s
 * `RenderAppOptions`. The web entries' store is `localStorage`-backed;
 * the embedded entry's store is in-memory only (the host re-pushes the
 * token over the gatekeeper bridge every WebView session, so a
 * persisted value can only ever be stale — see
 * `gatekeeper-react`'s `token-storage.ts`).
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
