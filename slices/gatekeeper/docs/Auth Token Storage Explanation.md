# Auth Token Storage Explanation

Why `gatekeeper-react`'s `client/auth-state-store.ts` ships **two**
`AuthStateStore` factories with different storage policies, and why the
embedded one deliberately ignores `localStorage`.

Both factories return the same `AuthStateStore` shape (a read-side
`subscribable` plus a `setAuthState` writer), so `AuthStateProvider`, the
page-bridge `AuthTokenIssued` handler, and the `auth-ready` gates are all
environment-blind. Only the `main-*` entrypoint, which knows which
environment it is in, picks a factory and threads the store through
`renderApp`. The `subscribable` carries a typed
[`AuthState`](../../../global/react-kitchen-sink/src/auth-state/auth-state.ts)
(`Unauthed | AuthedUntil(exp) | HostAuthed`), never a credential — the
**one** place the environments diverge is _which_ authed variant they
publish (see "What the web `subscribable` carries" below).

HTTP clients are tokenless: no client attaches an `Authorization` header.
Auth rides the same-origin `HttpOnly` `wf_auth` cookie the browser sends
automatically. The store's `subscribable` exists only as the
auth-readiness _signal_ — feeding `AuthStateProvider`, the `auth-ready`
gates, and the token-rotation cache invalidator — never as a header
source.

## `makeWebAuthStateStore` — cookie-derived (#218)

Used by the standalone web entries (`main-web` / `main-single-web`).

On the web path the real access token is the **`HttpOnly` `wf_auth`
cookie** the gatekeeper server sets at token issuance
(`gatekeeper-rust` `http/cookies.rs`). It is invisible to JS and sent
automatically on every request — including the initial document
navigation, before any JS runs — which is the whole point of #218: the
edge (and a future relay, #267) can read auth state even when the SPA
never loads. So the web store no longer _holds_ a token at all.

- It derives `AuthedUntil(exp)` from the readable companion cookie
  **`wf_auth_exp`** (carrying just the non-secret unix `exp`, never the
  signature) while the `exp` is in the future, else `Unauthed`.
- It re-derives on `focus` (cookies don't fire `'storage'`, so this is
  how a sign-in or logout in another tab surfaces). There is **no
  proactive expiry timer**: an `AuthedUntil(exp)` whose `exp` has passed
  is re-derived to `Unauthed` on the next focus, or the next authed
  request (which 401s and drives the device-login redirect). A consumer
  wanting sub-focus freshness can compare the signal's `exp` to now.
- `setAuthState` **ignores its argument** and just re-derives from the
  cookie. JS can't write the `HttpOnly` `wf_auth`; the server already did
  via `Set-Cookie` on the device-flow / refresh response. `NeedsAuthMessage`
  calls `setAuthState(...)` on sign-in completion to flip the signal (then
  reloads), so the same write seam works in both environments without the
  shared component knowing which it's in.
- **Clearing** the session is a server action (`POST /access/logout`,
  which sends `Max-Age=0` clears), not a `setAuthState(Unauthed())` — JS
  can't delete the `HttpOnly` cookie.

### What the web `subscribable` carries

The web `subscribable`'s value is `AuthedUntil(exp)` — the **non-secret
`exp` hint, not a usable bearer**. That is harmless because no client
ever reads it as a header: clients are tokenless and the cookie
authenticates same-origin requests on its own. The embedded store's
`subscribable` carries `HostAuthed` (authed, no page-known expiry): the
host holds the credential and syncs the `wf_auth` cookie into the
webview's jar, pushing only a contentless notify. Neither variant is a
credential — both drive only the readiness signal, and both environments'
requests authenticate via the cookie, never a JS-attached header.

There is no client-side `?token=` URL bootstrap: JS can't set an `HttpOnly`
cookie, so a token on the URL can't become `wf_auth`. Bootstrapping a
session from a URL would need a server endpoint that accepts the token and
sets the cookie.

## `makeEmbeddedAuthStateStore` — in-memory only

Used by the in-WebView SPA (`main-embedded`). Seeded `Unauthed`, no
`localStorage` read, no persistence subscriber, no cross-tab listener.
The host's `AuthTokenIssued` bridge handler is the sole writer — it
publishes `HostAuthed` (the host holds the credential; the page never
does).

The embedded store must **never** surface a `localStorage` value because
the embedded WebView's `WKWebsiteDataStore` outlives the host's JS
context: a Metro reload and, depending on iOS policy, even a force-kill
leave the previous session's token in storage. The LHS daemon mints a
fresh token and re-pushes it on every boot via the gatekeeper bridge, so
a `localStorage`-cached value can only ever be stale and racing the
host's fresh push. A stale value surfacing as the store's initial signal
would resolve the auth-ready gate early and pin TanStack Query loaders
on cached 401s.

## Why authed loaders gate on `beforeLoad`, not a component or a loader

On embedded the token does not exist at first paint — it arrives via the
host `AuthTokenIssued` bridge handler, which fires only **after** the
transport handshake (`transport.flushed`) completes. A TanStack `loader`
runs during routing, so an authed loader that fired on first paint would
`401` before the token landed.

The gate is therefore a **`beforeLoad`** on the pathless `_auth` /
`/settings` layouts (`apps/wildflower-react`'s `authGatedRouteOptions`),
which `await`s `context.awaitAuthReady(href)` — and on embedded
`awaitAuthReady` waits the same bridge handshake. Because `beforeLoad`
resolves before the route's `loader` and children render, every authed
loader beneath the gate is **guaranteed a token**; the slice loaders are
plain `ensureQueryData` with no `isTokenReady` reader (standalone web
resolves synchronously, since `wf_auth` is already present on the first
document request). A bounded **boot-race retry** in
`apps/wildflower-react/src/router-context.ts` (`unauthorizedRetrySchedule`)
covers only the residual window between gate-pass and the just-planted
cookie physically landing in the WebView's jar, and latches off once any
authed request succeeds so a genuine expiry redirects to device login
without delay.
