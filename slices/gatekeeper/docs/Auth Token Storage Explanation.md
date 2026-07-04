# Auth Token Storage Explanation

Why `gatekeeper-react`'s `client/token-storage.ts` ships **two**
`AuthTokenStore` factories with different storage policies, and why the
embedded one deliberately ignores `localStorage`.

Both factories return the same `AuthTokenStore` shape (a read-side
`subscribable` plus a `setSignal` writer), so `AuthTokenProvider`, the
page-bridge `AuthTokenIssued` handler, and the `auth-ready` gates are all
environment-blind. Only the `main-*` entrypoint, which knows which
environment it is in, picks a factory and threads the store through
`renderApp`. The `subscribable` carries a typed
[`AuthSignal`](../../global/react-kitchen-sink/src/auth-token/auth-signal.ts)
(`Unauthed | AuthedUntil(exp) | HostAuthed`), never a credential — the
**one** place the environments diverge is _which_ authed variant they
publish (see "What the web `subscribable` carries" below).

HTTP clients are tokenless: no client attaches an `Authorization` header.
Auth rides the same-origin `HttpOnly` `wf_auth` cookie the browser sends
automatically. The store's `subscribable` exists only as the
auth-readiness _signal_ — feeding `AuthTokenProvider`, the `auth-ready`
gates, and the token-rotation cache invalidator — never as a header
source.

## `makeWebAuthTokenStore` — cookie-derived (#218)

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
- `setSignal` **ignores its argument** and just re-derives from the
  cookie. JS can't write the `HttpOnly` `wf_auth`; the server already did
  via `Set-Cookie` on the device-flow / refresh response. `NeedsAuthMessage`
  calls `setSignal(...)` on sign-in completion to flip the signal (then
  reloads), so the same write seam works in both environments without the
  shared component knowing which it's in.
- **Clearing** the session is a server action (`POST /access/logout`,
  which sends `Max-Age=0` clears), not a `setSignal(Unauthed())` — JS
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

## `makeEmbeddedAuthTokenStore` — in-memory only

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
