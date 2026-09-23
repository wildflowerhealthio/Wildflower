# gatekeeper-core

The Gatekeeper system allows an authorized **Owner** on one device to issue
**Grants** to OAuth Clients (registered in the `clients` table) who request
access on a separate device, allowing them to access data in a system. The
host browser bootstraps onto a fresh deployment via the RFC 8628 device
authorization flow; on-device shells receive a host-minted token directly.

This package is the pure layer — schemas, HttpApi definitions, and business
rules. Platform adapters (e.g. `gatekeeper-react`) wire it up. SMART-on-FHIR is
the OAuth dialect spoken on the wire; details are in
[`docs/Jargon Explanation.md`](../docs/Jargon%20Explanation.md).

## Tables

The tables live in `gatekeeper-rust`'s store; they are described here
because the wire schemas in this package mirror their rows.

- `clients` — registered OAuth clients with per-client `redirectUris`
  allowlist, `allowedScopes`, and optional `secretHash` for confidential
  clients. `/oauth/token` and the device flow require a row; the
  authorization-code flow registers or widens a row when the Owner approves
  a `new` or `changed` consent prompt (trust on first use — see the
  [Jargon Explanation](../docs/Jargon%20Explanation.md#trust-on-first-use)).
- `authorizationRequests` — pending OAuth grants. A `grantType`
  discriminator (matching the wire `grant_type` parameter) splits
  between `'authorization_code'` (browser-side OAuth code grant) and
  `'device_code'` (RFC 8628). `status: 'pending' | 'approved' | 'denied'
| 'expired'`. Device-grant rows carry a `userCode` and `lastPolledAt`
  (for `slow_down`).
- `authorizationCodes` — single-use codes issued when a code-flow
  request is approved; consumed at `/oauth/token`.
- `authorizationCodeGrants` / `deviceGrants` — standing consents, **one
  table per concrete kind**, each carrying all of its columns:
  authorization-code grants (keyed `(clientId, redirectUri)`, driving the
  auto-approve fast path) and device grants (keyed
  `(clientId, deviceName)`, the durable record of a paired device). A
  `grants` SQL VIEW (`UNION ALL` of the two, with a `grantType` tag) backs
  the cross-kind reads; the wire stays one `grantType`-tagged union. See the
  [grants contrast](../../../docs/Apps/Polymorphic%20Rows%20Explanation.md#contrast-grants-table-per-kind)
  in apps' Polymorphic Rows Explanation for why grants took this over the
  shared-registration shape.
- `signingKeys` — RSA keys backing JWS signatures and the JWKS
  endpoint. `isActive: boolean` selects the signing key; verify-side
  iterates all keys for rotation.
- `httpRequests` — observability/gating ledger for inbound proxied
  requests.

`authorizationRequests`, `authorizationCodes`, and the refresh-token
lineage are the three that would otherwise only grow — a background sweep
reclaims them a fixed window past their own `expires_at` (7 days, 7 days,
and 90 days respectively). See the
[Retention Explanation](../docs/Retention%20Explanation.md).

## Routes

- `/.well-known/jwks.json` — public JWKs for token verification.
- `/oauth/authorize` — OAuth 2.0 authorization endpoint. An unknown
  `client_id`, an unregistered `redirect_uri`, or scopes outside the
  registration are carried to the consent prompt as a registration verdict
  rather than rejected (`wildflower-host` excepted). Always
  redirects to the polling page (`/gatekeeper/oauth-polling/:id`) on the
  hosted owner UI, with `?server=<served origin>` so the page knows which
  server to poll (the host serves no UI of its own; `page_paths.rs` builds
  the URL from the host-configured `OwnerUiBase`); the page picks
  same-device-vs-cross-device based on whether it's already authenticated.
- `/oauth/authorize/:id` — long-poll JSON status of an authorization
  request.
- `/oauth/device_authorization` — RFC 8628 device flow: returns
  `device_code` + `user_code` + verification URIs (under `/gatekeeper/devices`
  on the hosted owner UI, carrying `?server=`).
- `/oauth/token` — OAuth 2.0 token exchange. Accepts
  `grant_type=authorization_code` and
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- `/access/oauth-consents/:id` (+ `/approve`, `/deny`) — Owner actions
  on a pending OAuth code-flow request. The consent carries a `registration`
  verdict (`registered` / `new` / `changed`); approving a `new` or `changed`
  one requires `acknowledgedRegistration: true`.
- `/access/devices/:userCode` (+ `/approve`, `/deny`) — Owner actions
  on a pending device-flow request.
- `/access/grants`, `/access/grants/:id` — list / inspect / revoke
  standing grants.
- `/access/requests`, `/access/requests/:id` (+ `/approve`, `/deny`) —
  gate decisions on inbound HTTP requests.

## The SMART standalone-launch client

[`gatekeeper-core/smart-client`](./src/smart-client/index.ts) is the browser
side of the protocol `gatekeeper-rust` serves: a static Wildflower page points
itself at whichever server the reader runs (`server-target.ts`), asks that
server how to sign in (`smart-discovery.ts`), mints a PKCE pair (`pkce.ts`),
works out where the server should send the reader back to
(`redirect-target.ts`), leaves for `/oauth/authorize`, and picks the flow back
up on the way home (`authorization-flow.ts`, `sign-in.ts`).

It stays inside the `-core` layering rule by taking every impure edge — `fetch`,
Web Crypto, `sessionStorage` — as an injected `SignInEnvironment`. That
environment also carries everything app-specific: the `client_id`, the requested
`scope`, the redirect URI and the `sessionStorage` key the pending record lives
at. The key in particular is the app's to choose and should be namespaced with
the app's name, because these pages share an origin and an unqualified key would
let one page's return leg consume another's pending request.

What each page supplies, it supplies once. `browserSignInEnvironment(page,
registration)` does the wiring every browser caller would otherwise repeat —
including calling `fetch` as a method, since an unbound `Window.fetch` throws
`Illegal invocation` — and takes `page` structurally, so a test passes a plain
object instead of a `Window`. `STANDALONE_LAUNCH_SCOPES` is the requested
`scope` for both seeded public clients: migrations 0007 and 0012 register
identical `allowed_scopes`, with a `db/clients.rs` test that fails if they
drift, so the browser side is one list rather than a copy per app.

`internal/pkce.ts`'s `computeCodeChallenge` is a thin wrapper that binds
`codeChallengeS256`'s digest argument to the ambient Web Crypto; there is one
S256 implementation here, and a property test pins the two together.

### Deriving the redirect URI

`redirectUriForPage(href)` returns the page's own directory URL — the same
`new URL('.', href)` derivation the fhirclient-based apps use — or `undefined`
when the page is served somewhere a sign-in must not return to (a non-http(s)
origin, or plaintext http off loopback).

Deriving beats listing. `/oauth/authorize` matches `redirect_uri` by exact
string equality, so a page that picked from a compiled-in list could only sign
in from the addresses it was built for — not from a PR preview, and not from a
dev server on an unexpected port. Deriving also makes the match hold by
construction: the outbound string and the one derived again on the callback
(which arrives carrying `code` and `state`) come from the same directory.

An address the client has not registered is not a dead end. For every client but
the first-party host, `gatekeeper-rust` carries an unregistered `redirect_uri`
to the Owner's consent prompt as a warning and adds it to the row on approval
(`domain/client_registration.rs`), so the Owner is the gate rather than a list
inside the page.

The first-party host is the exception, in both directions: `/authorize` refuses
an unregistered redirect for it outright (the local `RedirectUriNotAllowed`
page), and `ensure_first_party_client` seeds it from code with no redirect URIs
at all. A browser page running this flow therefore cannot authorize as
`wildflower-host`; it needs a client row of its own, the way
`wildflower-server-docs` and `wildflower-react` have one.

### Returning to a route instead of a directory

`redirectUriForRoute(href, route, basePath)` resolves `route` under the app's
served root — the origin, plus `basePath` when the copy is published under a
subpath — sharing the scheme screen above. It is the form a single-page app
wants: a SPA on browser history has no stable directory, since the one a reader
signs in from is whichever section they were in (`/settings/foo` → `/settings/`),
and only one of those could ever be the registered entry. Resolving a fixed route
makes the value depend on the served root alone, which restores the
outbound-equals-callback property `redirectUriForPage` gets from the directory.

`basePath` is the slash-suffixed directory the build is served from
(`branding-core`'s `basenameOf(location.pathname)`), defaulting to `/` — so a
root-served copy is unchanged. A copy under `/app/` (or a PR preview's
`/staging/pr-<n>/app/`) passes that directory, so the route returns under it:
`/app/home`, the registered value, rather than `<origin>/home` off the app. The
caller derives `basePath` at the served root on both legs — the hosted owner UI
can, because its sign-in is reachable only from that root.

`route` is resolved against the origin first, so a spelling that escapes it —
`//evil.test/home`, or the `/\evil.test` that `URL` folds into it — yields
`undefined` rather than a URI pointing elsewhere (the same origin-equality guard
`gatekeeper-rust` applies to an app-relative allowlist entry) before its path is
re-rooted under `basePath`. The hosted owner UI (`apps/wildflower-react`'s
`main-web`) is the caller; the server-docs console still uses the directory form.

`insecureTargetReason` in `smart-discovery.ts` states the same scheme rule about
the _target_ that `usableEndpointUrl` enforces about the discovered endpoints, so
a page can explain up front that a secure page cannot reach a plaintext server
instead of surfacing it as a discovery failure. Loopback is exempt in both:
browsers treat `http://127.0.0.1` as trustworthy, which is what lets an HTTPS
page drive a desktop host.

### Not the other SMART client

This is **not** the fhirclient-based standalone launch in
`slices/emr/fhir-r4-react/src/smart/*`, which the self-hosted React apps use.
The two share `normalizeServerUrl` — this package owns the one implementation
and `fhir-r4-react` re-exports it — but nothing else: the launch here is
hand-rolled and Effect-native, and the one there delegates to `fhirclient`.

## SPA page paths

The gatekeeper API redirects to URLs under `/gatekeeper/`, which the host app
serves with a single-page app. The redirect targets are typed in
[`gatekeeper-core/page-paths`](./src/page-paths.ts) (`GatekeeperPaths`); the
SPA's file-based route tree in [`gatekeeper-react`](../gatekeeper-react/src/routes/)
mirrors them, and a drift test in
[`gatekeeper-react/src/routes.test.tsx`](../gatekeeper-react/src/routes.test.tsx)
enforces consistency. Serving the SPA itself is the host app's static-asset
concern (see [`apps/wildflower-react`](../../../apps/wildflower-react)), not
part of the gatekeeper-core contract.

Error pages are rendered inline by core via `internal/error-pages.ts` and are
not part of the page contract.

## Bootstrap URL (dev-mode workaround)

The host process (`gatekeeper-rust`, native shell, dev server) has direct
access to the signing key and can mint an owner access token directly.

The web SPA has no client-side URL-token consumption: it authenticates via
the `HttpOnly` `wf_auth` cookie the server sets at issuance, which JS can't
plant from a `?token=` param. Bootstrapping a web session from a URL would
need a server endpoint that accepts a minted token and sets the cookie;
until then the device flow is the path onto a cold web deployment. (The
embedded/Tauri path receives the host-minted token over the gatekeeper
bridge — see the Auth Token Storage Explanation.)

**The minting helpers are a dev convenience, not a shipping pattern**, and
the long-term story for first-Owner onboarding (native shell, fresh
deployment, CLI login) is unsettled. They stay behind a dev gate at the
call site, and the TTL is required there (no silent
default) so the minter — which has the dev-server / CI / shell context —
can pick it.
