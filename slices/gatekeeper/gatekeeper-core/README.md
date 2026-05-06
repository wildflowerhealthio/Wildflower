# gatekeeper-core

The Gatekeeper system allows an authorized **Owner** on one device to issue
**Grants** to OAuth Clients (registered in the `clients` table) who request
access on a separate device, allowing them to access data in a system. The
host browser bootstraps onto a fresh deployment via RFC 8628 device
authorization or a one-shot bootstrap URL minted by the host process.

This package is the pure layer — schemas, HttpApi definitions, and business
rules. Platform adapters (e.g. `gatekeeper-web`) wire it up. SMART-on-FHIR is
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
  redirects to the polling page (`/oauth/authorize/:id/view`); the
  browser's JS picks same-device-vs-cross-device based on
  `localStorage` Bearer presence.
- `/oauth/authorize/:id` — long-poll JSON status of an authorization
  request.
- `/oauth/device_authorization` — RFC 8628 device flow: returns
  `device_code` + `user_code` + verification URIs.
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

## Page contract (`gatekeeper-pages`)

Core ships only the HttpApi **definitions** for HTML pages — no handler layer.
A consumer slice (typically `gatekeeper-web`) provides the implementation via
`Layer.provide`. All pages are public HTML; auth is JS-driven via the Bearer
token the page's JS pulls from `localStorage`, which gates calls to the
`/access/*` JSON endpoints behind each page.

| Endpoint            | Path                                  | Purpose                                                                     |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `OAuthPollingPage`  | `GET /oauth/authorize/:id/view`       | Browser long-poll page; calls `GET /oauth/authorize/:id`.                   |
| `OAuthConsentPage`  | `GET /access/oauth-consents/:id/view` | Owner UI; reads `GET /access/oauth-consents/:id`.                           |
| `DeviceEntryPage`   | `GET /access/devices`                 | Manual `user_code` entry form; submits to `/access/devices/:userCode/view`. |
| `DeviceConsentPage` | `GET /access/devices/:userCode/view`  | Owner UI; reads `GET /access/devices/:userCode`.                            |

Error pages are rendered inline by core via `internal/error-pages.ts` and are
not part of the page contract.

## Bootstrap URL

The host process (gatekeeper-node, native shell, dev server) has direct
access to the signing key and can mint an access token via
`internal/jwt.ts:mintAccessToken(activeKey, origin, { clientId:
'wildflower-host', scope: ['owner'], ttl: Duration.minutes(5) })`. The
browser consumes the token from a `?token=` query param at startup,
stashes it in `localStorage`, and strips it from the URL via
`history.replaceState`.
Same primitive serves first-Owner bootstrap, native-shell launch, dev
workflow, CLI login, share-with-other-device, and test fixtures.

## Row-await helper

`internal/await-row.ts` exports `waitForRow`, an Effect helper that
suspends until a LiveStore row matches a predicate or a 5-minute timeout
fires (`ApprovalTimedOut`). Used by the HTTP-request approval gate
(`/access/requests/:id/approve|deny`); ships with tests but is not yet
wired to a call site.
