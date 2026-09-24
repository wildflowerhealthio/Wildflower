/**
 * {@link makeEmbeddedAuthStateStore}, the in-memory {@link AuthStateStore}
 * factory for the Tauri webview. Its sibling, {@link makeBearerAuthStateStore}
 * in `bearer-auth-state-store.ts`, serves an entry that runs cross-origin and
 * carries its own `Authorization` header. Both return the same
 * {@link AuthStateStore} shape so every consumer is environment-blind; only the
 * `main-*` entrypoint picks a factory.
 *
 * The factories are named for the **mechanism** — how the credential travels —
 * rather than for a deployment, because that is what actually decides which one
 * an entry can use.
 *
 * The store publishes a typed {@link AuthState}, never a credential: the Tauri
 * webview holds no credential at all. The host stamps its owner bearer onto
 * direct-loopback requests by connection provenance and pushes a contentless
 * notify, which the bridge turns into `HostAuthed`.
 *
 * See `slices/gatekeeper/docs/Auth Token Storage Explanation.md` for the
 * storage-policy rationale.
 */

import {
  type AuthState,
  type AuthStateStore,
  makeSubscribableStore,
  Unauthed,
} from 'react-kitchen-sink'

/**
 * Build the Tauri {@link AuthStateStore}: a `SubscriptionRef<AuthState>`
 * seeded `Unauthed`, no persistence subscriber, no cross-tab listener. The
 * host's `AuthTokenIssued` bridge handler is the sole writer (it publishes
 * `HostAuthed`); the value drives the auth-readiness signal (the `beforeLoad`
 * gate + the rotation invalidator). HTTP clients are tokenless — the host
 * authenticates the webview's direct-loopback fetches by connection provenance,
 * attaching its own owner bearer.
 *
 * Used by `main-tauri`; see the Auth Token Storage Explanation.
 */
const makeEmbeddedAuthStateStore = (): AuthStateStore => {
  const { subscribable, set: setAuthState } = makeSubscribableStore<AuthState>(Unauthed())
  return { subscribable, setAuthState }
}

export { makeEmbeddedAuthStateStore }
