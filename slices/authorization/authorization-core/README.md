# authorization-core

Wildflower Authorization allows an authorized **Owner** on one device to issue
**Grants** to OAuth Clients (registered in the `clients` table) who request
access on a separate device, allowing them to access data in a system. The
host browser bootstraps onto a fresh deployment via the RFC 8628 device
authorization flow; on-device shells receive a host-minted token directly.

This package is the pure layer — schemas, HttpApi definitions, and business
rules. Platform adapters (e.g. `authorization-react`) wire it up. SMART-on-FHIR is
the OAuth dialect spoken on the wire; details are in
[`docs/Jargon Explanation.md`](../docs/Jargon%20Explanation.md).

## Tables

The tables live in `authorization-server-rust`'s store; they are described here
because the wire schemas in this package mirror their rows.

- `clients` — registered OAuth clients with per-client `redirectUris`
  allowlist, `allowedScopes`, and optional `secretHash` for confidential
  clients. `/oauth/token` and the device flow require a row; the
  authorization-code flow registers or widens a row when the Owner approves
  a `new` or `changed` consent prompt (trust on first use — see the
  [Jargon Explanation](../docs/Jargon%20Explanation.md#trust-on-first-use)).
- `codeAuthorizationRequests` — requests of the browser-side OAuth code
  grant, waiting for the Owner. `status: 'awaiting_limited_page' |
  'pending' | 'approved' | 'denied'`.
- `userCodeRequests` — device requests (RFC 8628) and browser pairings,
  told apart by `flow: 'device_code' | 'browser_pairing'`. `status:
  'pending' | 'approved' | 'denied' | 'claimed'`. Each carries a `userCode`
  and `lastPolledAt` (for `slow_down`).
- `authorizationCodes` — single-use codes issued when a code-flow
  request is approved; consumed at `/oauth/token`.
- `launchContexts` — the SMART App Launch `launch` values an in-process
  launch minted, each bound to a `clientId` (and a nullable `patient`),
  consumed single-use within five minutes by that client's `/oauth/authorize`.
  Expired rows are pruned when the next is minted. See the
  [Jargon Explanation](../docs/Jargon%20Explanation.md#launchcontext).
- `authorizationCodeGrants` / `deviceGrants` — standing consents, **one
  table per concrete kind** (`authorization_code_grants`, `device_grants`;
  the authorization server migration `0001_gatekeeper_schema`), each carrying all of its
  columns with its own payload `NOT NULL`: authorization-code grants (keyed
  `(clientId, redirectUri)`, driving the auto-approve fast path) and device
  grants (keyed `(clientId, deviceName)`, the durable record of a paired
  device). Each kind's upsert key is a `UNIQUE` on its own table, so upserts
  and keyed lookups are single-table statements. Cross-kind reads (the access
  index, by-id lookups) go through the `grants` SQL VIEW (migration
  `0002_grants_view`): a `UNION ALL` of the two projecting the shared
  columns, a `grant_type` tag, and each kind's payload column, NULL for the
  other kind. Ids are UUIDs, so a by-id read through the view is
  unambiguous. The domain is one struct per kind (`AuthorizationCodeGrant`,
  `DeviceGrant`) sharing behaviour through the `CumulativeConsent` trait,
  with a thin `Grant` enum as the `grantType`-tagged wire union. See
  `authorization-server-rust/src/db/grants/` and `authorization-server-rust/src/domain/grant.rs`.
- `signingKeys` — RSA keys backing JWS signatures and the JWKS
  endpoint. `isActive: boolean` selects the signing key; verify-side
  iterates all keys for rotation.
- `httpRequests` — observability/gating ledger for inbound proxied
  requests.

The two request tables, `authorizationCodes`, and the refresh-token lineage
are the ones that would otherwise only grow — a background sweep reclaims
them a fixed window past their own `expires_at` (7 days for the requests and
codes, 90 days for the lineage). See the
[Retention](../../../apps/host/wildflower-server/authorization-server-rust/docs/Book/Domain/Retention%20Explanation.md) page of the authorization server book.

## Routes

- `/.well-known/jwks.json` — public JWKs for token verification.
- `/oauth/authorize` — OAuth 2.0 authorization endpoint. An unknown
  `client_id`, an unregistered `redirect_uri`, or scopes outside the
  registration are carried to the consent prompt as a registration verdict
  rather than rejected (the host app's client excepted). A request no standing
  grant covers redirects to the consent card below when the browser carries a
  live browser session, and to the wait page otherwise, relative to
  itself, so the browser stays on the server's origin.
- `/oauth/authorize/:id` — long-poll JSON status of an authorization
  request.
- `/oauth/authorize/:id/wait` — the **wait page**, served by the authorization server
  itself: static HTML, CSS and JS (`authorization-server-rust`'s
  `http/routes/oauth/wait_page/`) that polls `/oauth/authorize/:id` and, once
  the Owner decides, leaves for the redirect the status carries. It switches
  to the consent card once the browser can read the request's consent. See
  "Wait page" in the [Jargon Explanation](../docs/Jargon%20Explanation.md).
- `/oauth/authorize/:id/consent` — the **consent card**, where a browser
  signed in as the Owner decides the request through `/authorization/oauth-consents/:id`
  and leaves for the callback the decision carries. A React page from
  `apps/host/wildflower-server/authorization-server-web`, which the
  authorization server embeds; its hashed assets are at `/oauth/assets/*`.
  See "Consent card" in the
  [Jargon Explanation](../docs/Jargon%20Explanation.md).
- `/oauth/device` — the **device page**, the RFC 8628 verification page,
  where a browser signed in as the Owner confirms a device's code and decides the request
  through `/authorization/devices/:userCode`. From the same bundle as the
  consent card. See "Device page" in the
  [Jargon Explanation](../docs/Jargon%20Explanation.md).
- `/oauth/device_authorization` — RFC 8628 device flow: returns
  `device_code` + `user_code` + verification URIs on the server's own origin
  (`/oauth/device`, and `/oauth/device?user_code=` for
  `verification_uri_complete`).
- `/oauth/pair` — the **pairing page**, from the same bundle, where a browser
  that isn't the Owner's shows a code the Owner approves on the device page.
  It starts a browser pairing at `/oauth/pair/start` and polls
  `/oauth/pair/poll`, whose answer once approved sets the browser's session
  cookie. Pairing is no OAuth flow. See "Browser pairing" in the
  [Jargon Explanation](../docs/Jargon%20Explanation.md).
- `/oauth/token` — OAuth 2.0 token exchange. Accepts
  `grant_type=authorization_code` and
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- `/authorization/oauth-consents/:id` (+ `/approve`, `/deny`) — Owner actions
  on a pending OAuth code-flow request. The consent carries a `registration`
  verdict (`registered` / `new` / `changed`); approving a `new` or `changed`
  one requires `acknowledgedRegistrationChange: true`. A decision answers with the
  client's callback (`redirect`: the code on an approval, `access_denied` on a
  denial), for the consent card to leave for.
- `/authorization/devices/:userCode` (+ `/approve`, `/deny`) — Owner actions
  on a pending device-flow request or browser pairing (`kind`).
- `/authorization/grants`, `/authorization/grants/:id` — list / inspect / revoke
  standing grants.
- `/authorization/clients`, `/authorization/clients/:clientId` — list every registered
  client, and `PATCH` one's `disabledAt` to take trust back (a UTC time) or
  restore it (`null`); an essential client (the host app's or the
  browser-session client) can't be disabled (`409 EssentialClient`).
- `/authorization/revocations` — revoke issued tokens now: every token a
  subject (`client_id`) holds, or one token by `jti`.
- `/authorization/browser-sessions`, `/authorization/browser-sessions/:sid` —
  list the live browser sessions, the caller's marked `heldByCaller`, and
  revoke one, which ends everything minted under it.
- `/oauth/sign-out` — a browser ending its own browser session (a form post
  authenticated by its `__Host-browser_session` cookie): the session is
  revoked, the cookie cleared, and the browser sent on to the launcher. See
  [Browser session](../docs/Jargon%20Explanation.md#browser-session).

## The SMART sign-in client

[`authorization-core/smart-client`](./src/smart-client/index.ts) is the browser
side of the protocol `authorization-server-rust` serves: a static Wildflower page points
itself at whichever server the reader runs (`server-target.ts`), asks that
server how to sign in (`smart-discovery.ts`), mints a PKCE pair (`pkce.ts`),
works out where the server should send the reader back to
(`redirect-target.ts`), leaves for `/oauth/authorize`, and picks the flow back
up on the way home (`authorization-flow.ts`, `sign-in.ts`).

`arrivingSmartLaunchFrom` (`arriving-launch.ts`) reads the SMART launch a page
was opened with, `iss` and the EHR's `launch` (`SMART_LAUNCH_PARAMS`), off its
query string. The fhirclient-based SMART apps read it through
`fhir-r4-react/smart`, which re-exports both. A page that signs in with this package turns a launch into its
`?server=` with `searchAfterArrivingLaunch` (`server-target.ts`): `iss` and
`launch` leave the URL, and `?server=` becomes the server `iss` names, in
`normalizeServerUrl`'s canonical form: a Wildflower server serves FHIR at its
root, so its `iss` is its address.

A sign-in is a SMART standalone launch unless the app hands `beginSignIn` a
non-empty `launch`: the EHR launch value it was opened with (the launching system's
`?launch=`). That value goes into the authorization request as `launch`, beside
the discovered `aud`, and nowhere else — the return leg does not need it, so the
pending record does not carry it.

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
`scope` for the server-docs console's seeded public client (migration 0007).

The server URL a sign-in starts from is its FHIR base — the SMART `iss`, which
the authorization request also names as its `aud`: a Wildflower server serves
FHIR at its root (or at the root of the path prefix it is published behind),
and a plain SMART server's URL is its FHIR base (the SmartHealthIT demo's).
`discoverSmartEndpoints(serverUrl, …)` reads
`{serverUrl}/.well-known/smart-configuration`, and the document says which kind
of server it is: a Wildflower server lists `WILDFLOWER_SERVER_CAPABILITY`
(`wildflower-server`, advertised by `fhir-r4-rust`'s discovery override) among
its `capabilities`. Any failure — unreachable, blocked by CORS, a 404 or another
status — is reported as it is. It returns the `SmartServer` the document
describes — `WildflowerServer` or `PlainSmartServer`, each carrying its
`fhirBaseUrl` — with the endpoints, and `beginSignIn` names that base as the
`aud`. The discovered token endpoint, `serverUrl` and the
`SmartServer` ride the pending record, so the return leg is the same either way
and the redeemed `Session` says which kind of server it signed in to. The
`Session` also carries the token response's `patient`, the launch context a
plain SMART server names once the reader picks a patient.

`internal/pkce.ts`'s `computeCodeChallenge` is a thin wrapper that binds
`codeChallengeS256`'s digest argument to the ambient Web Crypto; there is one
S256 implementation here, and a property test pins the two together.

### Deriving the redirect URI

`redirectUriForPage(href)` returns the page's own directory URL — the
derivation the fhirclient-based apps use through `fhir-r4-react/smart`'s
`appRootRedirectUri` — or `undefined`
when the page is served somewhere a sign-in must not return to (a non-http(s)
origin, or plaintext http off loopback).

Deriving beats listing. `/oauth/authorize` matches `redirect_uri` by exact
string equality, so a page that picked from a compiled-in list could only sign
in from the addresses it was built for — not from a PR preview, and not from a
dev server on an unexpected port. Deriving also makes the match hold by
construction: the outbound string and the one derived again on the callback
(which arrives carrying `code` and `state`) come from the same directory.

An address the client has not registered is not a dead end. For every client but
the host app's, `authorization-server-rust` carries an unregistered `redirect_uri`
to the Owner's consent prompt as a warning and adds it to the row on approval
(`domain/client/presented_change.rs`), so the Owner is the gate rather than a list
inside the page.

The host app's client is the exception, in both directions: its registration
is fixed, so `/authorize` refuses an unregistered redirect for it outright
(the local `RedirectUriNotAllowed` page), and `ensure_essential_clients` seeds
it from code with no redirect URIs at all. A browser page running this flow
therefore cannot authorize as the host app's client; it needs a client row of its
own, the way `server-docs-web` and `launcher-web` have one.

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
root-served copy is unchanged — the published launcher, at the root of
`https://launcher.wildflowerhealth.io`, returns to that root, the registered
value. A copy under a PR preview's `/pr-<n>/` passes that
directory, so the route returns under it rather than to `<origin>/` off the
app. The
caller derives `basePath` at the served root on both legs — the hosted launcher
can, because its sign-in is reachable only from that root.

`route` is resolved against the origin first, so a spelling that escapes it —
`//evil.test/home`, or the `/\evil.test` that `URL` folds into it — yields
`undefined` rather than a URI pointing elsewhere, before its path is re-rooted
under `basePath`. The hosted launcher (`apps/launcher/launcher-web`'s
`main-web`) is the caller; the server-docs console still uses the directory form.

`insecureTargetReason` in `smart-discovery.ts` states the same scheme rule about
the _target_ that `usableEndpointUrl` enforces about the discovered endpoints, so
a page can explain up front that a secure page cannot reach a plaintext server
instead of surfacing it as a discovery failure. Its wording names no kind of
page, since the server-docs console, the hosted launcher and every SMART app's
connect menu (through `fhir-r4-react/smart`'s re-export) show it, and offers
all three ways out: an https address, the page opened over http from the
server itself, or a server on this computer. Loopback is
exempt in both:
browsers treat `http://127.0.0.1` as trustworthy, which is what lets an HTTPS
page drive a desktop host.

### Not the other SMART client

This is **not** the fhirclient-based standalone launch in
`slices/fhir/fhir-r4-react/src/smart/*`, which the React SMART apps use.
The two share this package's helpers — `normalizeServerUrl`,
`insecureTargetReason` and `arrivingSmartLaunchFrom`, which `fhir-r4-react`
re-exports, and the endpoint checks: its probe runs a configuration through
`smartIssuerFrom`, and its authorize navigation runs fhirclient's authorize URL
through `endpointUrlFrom`, the reason-carrying form of `usableEndpointUrl` —
but not the launch itself: the launch here is hand-rolled and Effect-native,
and the one there delegates to `fhirclient`.

## Bootstrap URL (dev-mode workaround)

The host process (`authorization-server-rust`, native shell, dev server) has direct
access to the signing key and can mint an owner access token directly.

The web SPA has no client-side URL-token consumption: it holds only the
bearer its own sign-in (SMART redirect or device flow) obtains, in page
memory (see the Auth Token Storage Explanation).

**The minting helpers are a dev convenience, not a shipping pattern**, and
the long-term story for first-Owner onboarding (native shell, fresh
deployment, CLI login) is unsettled. They stay behind a dev gate at the
call site, and the TTL is required there (no silent
default) so the minter — which has the dev-server / CI / shell context —
can pick it.
