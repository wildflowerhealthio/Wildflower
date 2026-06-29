# Auth Token Storage Explanation

Why `gatekeeper-react`'s `client/token-storage.ts` ships **two**
`AuthTokenStore` factories with different storage policies, and why the
embedded one deliberately ignores `localStorage`.

Both factories return the same `AuthTokenStore` shape (a read-side
`subscribable` plus a `setToken` writer), so `AuthTokenProvider`, the
page-bridge `AuthTokenIssued` handler, and the `auth-ready` gates are all
environment-blind. Only the `main-*` entrypoint, which knows which
environment it is in, picks a factory and threads the store through
`renderApp`. The **one** place the environments diverge is the
`BearerToken` source (see "What the web `subscribable` carries" below).

## `makeWebAuthTokenStore` — cookie-derived (#218)

Used by the standalone web entries (`main-web` / `main-single-web`).

On the web path the real access token is the **`HttpOnly` `wf_auth`
cookie** the gatekeeper server sets at token issuance
(`gatekeeper-rust` `http/cookies.rs`). It is invisible to JS and sent
automatically on every request — including the initial document
navigation, before any JS runs — which is the whole point of #218: the
edge (and a future relay, #267) can read auth state even when the SPA
never loads. So the web store no longer _holds_ a token at all.

- It derives an "authed until `exp`" signal from the readable companion
  cookie **`wf_auth_exp`** (carrying just the non-secret unix `exp`,
  never the signature). The `subscribable` yields that `exp` string while
  it's in the future, else `null`.
- It re-derives on `focus` / `visibilitychange` (cookies don't fire
  `'storage'`, so this is how a sign-in or logout in another tab
  surfaces) and arms a timer to flip the signal to `null` the moment the
  hint expires.
- `setToken` **ignores its argument** and just re-derives from the
  cookie. JS can't write the `HttpOnly` `wf_auth`; the server already did
  via `Set-Cookie` on the device-flow / refresh response. `NeedsAuthMessage`
  calls `setToken(...)` on sign-in completion to flip the signal (then
  reloads), so the same write seam works in both environments without the
  shared component knowing which it's in.
- **Clearing** the session is a server action (`POST /access/logout`,
  which sends `Max-Age=0` clears), not a `setToken(null)` — JS can't
  delete the `HttpOnly` cookie.

### What the web `subscribable` carries (and why `BearerToken` is separate)

The web `subscribable`'s value is the **`exp` hint, not a usable
bearer**. So the web entry deliberately feeds the Effect-side
`BearerToken` a _separate_ always-`null` source
(`makeWebEntryOptions().bearerTokenSubscribable`): no `Authorization`
header is ever set, and the cookie authenticates same-origin requests on
its own. Wiring the auth-signal subscribable into `BearerToken` would
send the `exp` string as a bogus bearer. The embedded path omits the
override, so `BearerToken` defaults to its store's real-JWT subscribable.

There is no client-side `?token=` URL bootstrap: JS can't set an `HttpOnly`
cookie, so a token on the URL can't become `wf_auth`. Bootstrapping a
session from a URL would need a server endpoint that accepts the token and
sets the cookie.

## `makeEmbeddedAuthTokenStore` — in-memory only

Used by the in-WebView SPA (`main-embedded`). Seeded with `null`, no
`localStorage` read, no persistence subscriber, no cross-tab listener.
The host's `AuthTokenIssued` bridge handler is the sole writer.

The embedded store must **never** surface a `localStorage` value because
the embedded WebView's `WKWebsiteDataStore` outlives the host's JS
context: a Metro reload and, depending on iOS policy, even a force-kill
leave the previous session's token in storage. The LHS daemon mints a
fresh token and re-pushes it on every boot via the gatekeeper bridge, so
a `localStorage`-cached value can only ever be stale and racing the
host's fresh push. A stale bearer surfacing as the store's initial value
would resolve the auth-ready gate early and pin TanStack Query loaders
on cached 401s.
