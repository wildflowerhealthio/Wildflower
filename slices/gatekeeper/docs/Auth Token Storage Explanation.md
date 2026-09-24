# Auth Token Storage Explanation

Why the owner UI's two entries hold their auth state in different stores, and
why neither store is a cookie.

The server authenticates by the `Authorization: Bearer` header alone: it issues
no cookies and reads none. Each `main-*` entrypoint, which knows which
environment it is in, picks an `AuthStateStore` factory and threads the store
through `renderApp`. Every store has the same shape (a read-side
`subscribable` plus a `setAuthState` writer), so `AuthStateProvider`, the
page-bridge `AuthTokenIssued` handler, and the `auth-ready` gates are all
environment-blind. The `subscribable` carries a typed
[`AuthState`](../../../global/react-kitchen-sink/src/auth-state/auth-state.ts)
(`Unauthed | AuthedUntil(exp) | HostAuthed`) — the auth-readiness _signal_
feeding `AuthStateProvider`, the `auth-ready` gates, and the token-rotation
cache invalidator.

## `makeBearerAuthStateStore` — the hosted web entry (`main-web`)

`main-web` runs cross-origin to the server named by `?server=`. It signs in
through SMART (or the device flow) and holds the bearer **in memory only** —
never `localStorage`, `sessionStorage` or a cookie — so it dies with the tab.
The store publishes `AuthedUntil(exp)` for the held bearer, and the entry's
`attachBearer` stamps `Authorization: Bearer` on its API requests. Logout
forgets the bearer, then asks the server to revoke it (`POST /access/logout`).

## `makeEmbeddedAuthStateStore` — the Tauri entry (`main-tauri`)

Seeded `Unauthed`, no `localStorage` read, no persistence subscriber, no
cross-tab listener. The page holds **no credential**: the host keeps its
minted owner token host-side and presents it on the page's direct-loopback
API requests (loopback-provenance owner trust). The host's `AuthTokenIssued`
bridge handler is the sole writer — it publishes `HostAuthed` (authed, no
page-known expiry) and carries no secret.

The embedded store must **never** surface a `localStorage` value because the
embedded WebView's data store outlives the host's JS context: a reload and,
depending on OS policy, even a force-kill leave the previous session's state in
storage. The host mints a fresh token and re-notifies on every boot, so a
cached value can only ever be stale and racing the host's fresh push. A stale
value surfacing as the store's initial signal would resolve the auth-ready gate
early and pin TanStack Query loaders on cached 401s.

## Why authed loaders gate on `beforeLoad`, not a component or a loader

On Tauri the host's owner token does not exist at first paint — the host binds
its loopback listener before it mints the token, and the page learns the token
exists via the `AuthTokenIssued` bridge notify. A TanStack `loader` runs during
routing, so an authed loader that fired on first paint would `401` before the
token was minted.

The gate is therefore a **`beforeLoad`** on the pathless `_auth` /
`/settings` layouts (`apps/wildflower-react`'s `authGatedRouteOptions`),
which `await`s `context.awaitAuthReady(href)`. Because `beforeLoad` resolves
before the route's `loader` and children render, every authed loader beneath
the gate runs once auth is ready; the slice loaders are plain
`ensureQueryData` with no `isTokenReady` reader. A bounded **boot-race retry**
(`unauthorizedRetrySchedule` in `apps/wildflower-react/src/retry-policy.ts`)
covers the residual window between gate-pass and the host's owner token being
live, and latches off once any authed request succeeds so a genuine expiry
redirects to sign-in without delay.
