# Auth Token Storage Explanation

Where the launcher holds its session, and why the store is not a cookie.

The server authenticates by the `Authorization: Bearer` header alone: it issues
no cookies and reads none. The launcher's entry (`main-web`) builds a
`makeBearerAuthStateStore` and threads it through `buildAppTree`. The store has
the shape every consumer reads (a read-side `subscribable` plus a
`setAuthState` writer), so `AuthStateProvider` and the `auth-ready` gate are
unaware of how the credential travels. The `subscribable` carries a typed
[`AuthState`](../../../global/react-kitchen-sink/src/auth-state/auth-state.ts)
(`Unauthed | AuthedUntil(exp) | HostAuthed`) — the auth-readiness _signal_
feeding `AuthStateProvider`, the `auth-ready` gate, and the token-rotation
cache invalidator.

## `makeBearerAuthStateStore` — the launcher's session

The launcher is the build the site publishes at `/launcher/`. It runs
cross-origin to its API server. It signs in through SMART (or the device flow)
and holds the session — the server it signed in to and the bearer that server
issued — written together by `writeSession`.

- **The bearer is in memory only** — never `localStorage`, `sessionStorage` or
  a cookie — so it dies with the tab, and `setAuthState(Unauthed())` drops it.
  The store publishes `AuthedUntil(exp)` for the held bearer (`HostAuthed`
  when the token response reported no lifetime).
- **The server is in the tab's `sessionStorage`.** It is no credential, and a
  reload or the expiry bounce back to the landing signs back in to it.

The launcher's transport reads both on every request: it addresses the
request to the session's server and stamps `Authorization: Bearer` on it.
Logout forgets the bearer, asks the session's server to revoke it
(`POST /access/logout`), and clears the tab's `sessionStorage`.

## Why authed loaders gate on `beforeLoad`, not a component or a loader

A TanStack `loader` runs during routing, so an authed loader that fired before
a sign-in would `401`.

The gate is therefore a **`beforeLoad`** on the pathless `_auth` /
`/settings` layouts and the `/fhir-home` route (`apps/launcher/launcher-web`'s
`session/auth-gated-route-options.ts`),
which `await`s `context.awaitAuthReady(href)`: with no session it redirects to
the landing page. Because `beforeLoad` resolves before the route's `loader`
and children render, every authed loader beneath the gate runs once auth is
ready; the slice loaders are plain `ensureQueryData` with no `isTokenReady`
reader. A bounded **boot-race retry** (`unauthorizedRetrySchedule` in
`apps/launcher/launcher-web/src/retry-policy.ts`) re-sends a `401` that
arrives in the first moments after the gate passes, and latches off once any
authed request succeeds so a genuine expiry redirects to sign-in without
delay.
