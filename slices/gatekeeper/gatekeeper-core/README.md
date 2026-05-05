# gatekeeper-core

The Gatekeeper system allows an authorized **Owner** on one device to issue
**Grants** to OAuth Clients or to **Session** cookies requested on a separate
device, allowing them to access data in a system, and possibly act as Owners.

This package is the pure layer — schemas, HttpApi definitions, and business
rules. Platform adapters (e.g. `gatekeeper-web`) wire it up. SMART-on-FHIR is
the OAuth dialect spoken on the wire; details are in
[`docs/Jargon Explanation.md`](../docs/Jargon%20Explanation.md).

## Tables

- `authorizationRequests` — pending OAuth authorization requests (`status:
'pending' | 'approved' | 'denied' | 'expired'`).
- `authorizationCodes` — single-use codes issued when a request is approved;
  consumed at `/oauth/token`.
- `grants` — standing OAuth consents indexed by `clientId` + `redirectUri`.
- `sessions` — PIN-issued sessions; `id` matches the JWT `sub` claim.
- `pinChallenges` — outstanding PIN flows (`status: 'pending' | 'verified' |
'rejected' | 'expired'`).
- `signingKeys` — RSA keys backing JWS signatures and the JWKS endpoint.
- `httpRequests` — observability/gating ledger for inbound proxied requests.

## Routes

- `/.well-known/jwks.json` — public JWKs for token verification.
- `/oauth/authorize` — OAuth 2.0 authorization endpoint. `?display=polling`
  switches to the out-of-band-polling display mode.
- `/oauth/authorize/:id` — long-poll status of an authorization request.
- `/oauth/token` — OAuth 2.0 token exchange.
- `/login/pin`, `/login/pin/:id`, `/login/pin/:id/complete` — host-device PIN
  login flow.
- `/access/oauth-consents/:id` (+ `/approve`, `/deny`) — Owner actions on a
  pending OAuth request.
- `/access/pin-verifications/:id` (+ `/verify`, `/deny`) — Owner actions on
  a pending PIN challenge.
- `/access/grants`, `/access/grants/:id` — list / inspect / revoke standing
  grants.
- `/access/requests`, `/access/requests/:id` (+ `/approve`, `/deny`) — gate
  decisions on inbound HTTP requests.

## Page contract (`gatekeeper-pages`)

Core ships only the HttpApi **definitions** for HTML pages — no handler layer.
A consumer slice (typically `gatekeeper-web`) provides the implementation via
`Layer.provide`:

| Endpoint              | Path                                   | Purpose                                                   |
| --------------------- | -------------------------------------- | --------------------------------------------------------- |
| `OAuthPollingPage`    | `GET /oauth/authorize/:id/page`        | Browser long-poll page; calls `GET /oauth/authorize/:id`. |
| `OAuthConsentPage`    | `GET /access/oauth-consents/:id/ui`    | Owner UI; reads `GET /access/oauth-consents/:id`.         |
| `PinLoginPage`        | `GET /login/pin/:id/page`              | PIN entry page; polls `GET /login/pin/:id`.               |
| `PinVerificationPage` | `GET /access/pin-verifications/:id/ui` | Owner UI; reads `GET /access/pin-verifications/:id`.      |

Error pages are rendered inline by core via `internal/error-pages.ts` and are
not part of the page contract.

## Out-of-band approval helper

`internal/out-of-band-approval.ts` exports `waitForRow`, an Effect helper that
suspends until a LiveStore row matches a predicate or a 5-minute timeout
fires (`ApprovalTimedOut`). Designed for gated-request flows; ships with tests
but is not yet wired to a call site.
