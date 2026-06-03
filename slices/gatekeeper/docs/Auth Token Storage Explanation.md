# Auth Token Storage Explanation

Why `gatekeeper-react`'s `client/token-storage.ts` ships **two**
`AuthTokenStore` factories with different storage policies, and why the
embedded one deliberately ignores `localStorage`.

Both factories return the same `AuthTokenStore` shape (a read-side
`subscribable` plus a `setToken` writer), so `AuthTokenProvider`, the
`BearerToken` Layer, the page-bridge `AuthTokenIssued` handler, and the
`auth-ready` gates are all environment-blind. Only the `main-*`
entrypoint, which knows which environment it is in, picks a factory and
threads the store through `renderApp`.

## `makeWebAuthTokenStore` — `localStorage`-backed

Used by the standalone web entries (`main-web` / `main-single-web`).

- Seeds the underlying `SubscriptionRef` from the current
  `localStorage` value at construction time.
- `setToken` writes through to both the ref and `localStorage` in one
  synchronous step — no forked subscriber, no microtask gap between the
  call and the value being visible in storage.
- A `'storage'` event listener mirrors cross-tab writes into the ref. A
  current-value guard keeps the listener from storming the ref with a
  value this tab just wrote (browsers don't fire `'storage'` on the
  writing tab, but the guard hardens the contract against future spec
  relaxations and any code path that writes `localStorage` outside
  `setToken`).
- Consumes a `?token=…` URL bootstrap parameter into `localStorage`
  before construction (the dev flow that `wildflower-node` logs at
  startup), then strips it from the address bar.

### Why the URL token is validated against a JWT shape

The `?token=` query parameter is attacker-controllable. Before it is
persisted it is checked against `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`
(three non-empty base64url segments). A value that fails the check is
treated as if no usable token was supplied: the existing stored token is
left untouched, but the `?token=` param is still stripped from the URL
so the malformed value can't linger in browser history or `Referer`
headers. Dropping this guard is a security regression — a malformed
`?token=` would otherwise clobber a previously-valid stored bearer.

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
