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
  allowlist, `allowedScopes` cap, and optional `secretHash` for
  confidential clients. Every accepted `client_id` resolves here.
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

## Routes

- `/.well-known/jwks.json` — public JWKs for token verification.
- `/oauth/authorize` — OAuth 2.0 authorization endpoint. Always
  redirects to the polling page (`/gatekeeper/oauth-polling/:id`); the
  browser's JS picks same-device-vs-cross-device based on whether it's
  already authenticated (the `wf_auth` cookie on web, the host-provided
  token on device).
- `/oauth/authorize/:id` — long-poll JSON status of an authorization
  request.
- `/oauth/device_authorization` — RFC 8628 device flow: returns
  `device_code` + `user_code` + verification URIs (under `/gatekeeper/devices`).
- `/oauth/token` — OAuth 2.0 token exchange. Accepts
  `grant_type=authorization_code` and
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- `/access/oauth-consents/:id` (+ `/approve`, `/deny`) — Owner actions
  on a pending OAuth code-flow request.
- `/access/devices/:userCode` (+ `/approve`, `/deny`) — Owner actions
  on a pending device-flow request.
- `/access/grants`, `/access/grants/:id` — list / inspect / revoke
  standing grants.
- `/access/requests`, `/access/requests/:id` (+ `/approve`, `/deny`) —
  gate decisions on inbound HTTP requests.

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
