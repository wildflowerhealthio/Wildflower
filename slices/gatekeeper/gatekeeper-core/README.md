# gatekeeper-core

The Gatekeeper system allows an authorized **Owner** on one device to issue
**Grants** to OAuth Clients (registered in the `clients` table) who request
access on a separate device, allowing them to access data in a system. The
host browser bootstraps onto a fresh deployment via RFC 8628 device
authorization or a one-shot bootstrap URL minted by the host process.

This package is the pure layer — schemas, HttpApi definitions, and business
rules. Platform adapters (e.g. `gatekeeper-react`) wire it up. SMART-on-FHIR is
the OAuth dialect spoken on the wire; details are in
[`docs/Jargon Explanation.md`](../docs/Jargon%20Explanation.md).

## Tables

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
- `grants` — standing OAuth consents indexed by `(clientId,
redirectUri)`. Grant lookups drive the auto-approve fast path.
- `signingKeys` — RSA keys backing JWS signatures and the JWKS
  endpoint. `isActive: boolean` selects the signing key; verify-side
  iterates all keys for rotation.
- `httpRequests` — observability/gating ledger for inbound proxied
  requests.

## Routes

- `/.well-known/jwks.json` — public JWKs for token verification.
- `/oauth/authorize` — OAuth 2.0 authorization endpoint. Always
  redirects to the polling page (`/gatekeeper/oauth-polling/:id`); the
  browser's JS picks same-device-vs-cross-device based on
  `localStorage` Bearer presence.
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
SPA's file-based route tree in [`gatekeeper-react`](../gatekeeper-react/src/routeTree.gen.ts)
mirrors them, and a drift test in
[`gatekeeper-react/src/routes.test.tsx`](../gatekeeper-react/src/routes.test.tsx)
enforces consistency. Serving the SPA itself is the host app's static-asset
concern (see [`apps/wildflower-react`](../../../apps/wildflower-react)), not
part of the gatekeeper-core contract.

Error pages are rendered inline by core via `internal/error-pages.ts` and are
not part of the page contract.

## Bootstrap URL (dev-mode workaround)

The host process (gatekeeper-node, native shell, dev server) has direct
access to the signing key and can mint an access token via
`mintHostOwnerToken({ ttl })` (or `internal/jwt.ts:mintAccessToken` for
ad-hoc cases). The browser consumes the token from a `?token=` query
param at startup, stashes it in `localStorage`, and strips it from the
URL via `history.replaceState`.

**This is a dev convenience, not a shipping pattern.** The long-term
story for first-Owner onboarding (native shell, fresh deployment, CLI
login) is unsettled; the device flow is the production path. Until that
shakes out, the helpers live behind a dev gate at the call site (e.g.
`apps/wildflower-node` only mints when `NODE_ENV !== 'production'`).
The TTL is required at the call site (no silent default) so the
minter — which has the dev-server / CI / shell context — can pick.
`apps/wildflower-node` currently passes 1 hour: long enough to be less
annoying than re-minting through every page reload, short enough that a
leaked URL stops being useful within a working session. The value is a
dev workaround; long-term TBD.

## Row-await helper

`internal/await-row.ts` exports `waitForRow`, an Effect helper that
suspends until a LiveStore row matches a predicate or a 5-minute timeout
fires (`ApprovalTimedOut`). Used by the HTTP-request approval gate
(`/access/requests/:id/approve|deny`); ships with tests but is not yet
wired to a call site.
