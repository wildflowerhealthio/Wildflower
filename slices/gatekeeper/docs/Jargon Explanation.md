# Gatekeeper Jargon Explanation

This doc fixes the meaning of every domain term that appears in the
`gatekeeper` slice — internal vocabulary first, then the OAuth 2.0 / OIDC
spec terms that show up in the code. The goal is to surface concepts that
overlap so a future round can decide whether to merge or rename them.

Everything here is **descriptive of the code as it stands today**. Open
questions about whether two concepts should collapse are flagged with
**Open question:** callouts.

## What gatekeeper is for

The Gatekeeper system allows an authorized **Owner** on one device to
issue **Grants** to OAuth Clients (registered in the
[`clients`](#client) table) requesting access on a separate device,
allowing them to access data in a system. The host browser bootstraps
onto a fresh deployment via either the RFC 8628 device authorization
flow or a one-shot [bootstrap URL](#bootstrap-url).

## Roles

Three distinct human/machine roles whose names collide easily — get these
straight first.

| Role               | Who they are                                                                                                  | Where they show up                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **OAuth client**   | Remote app requesting access (the SMART-on-FHIR caller, or `wildflower-host` itself).                         | `client_id`, `redirect_uri`, `/oauth/...` endpoints, the [`clients`](#client) table  |
| **Owner**          | Human with absolute control over the data this gatekeeper protects. Approves consent, gates inbound requests. | `/access/...` endpoints, `RequireAuthMiddleware`, Bearer tokens with `'owner'` scope |
| **Resource owner** | OAuth-spec name for the Owner — the person whose data is being shared.                                        | OAuth spec only; we say "Owner"                                                      |

> **Open question:** The OAuth `client` (third-party app) is unrelated to
> any LiveStore "client" instance — the word is overloaded. The spec name
> wins for `client_id`, but we should never use bare "client" in
> Gatekeeper prose without a qualifier.

## Slice-internal terms

These are the concepts named in `gatekeeper-core/src/livestore/` and
`gatekeeper-core/src/contexts/`. Each one corresponds to either a table,
an event, or a Tag.

### Client

A registered OAuth client. Every `client_id` accepted on
`/oauth/authorize`, `/oauth/token`, or `/oauth/device_authorization` must
resolve to a row in this table — unknown ids are rejected at the
boundary.

- **Table:** `clients`
- **Identifier:** `clientId` (string PK, not a generated id — the
  registrar supplies it).
- **Kind:** `'public' | 'confidential'`. Confidential clients carry a
  `secretHash` (SHA-256) and must present `client_secret` on
  `/oauth/token`, verified by `timingSafeEqual`.
- **Allowlists:** `redirectUris` (exact match) and `allowedScopes`
  (hard cap on what this client can request).
- **Lifecycle:** `clientRegistered` → `clientUpdated` → `clientDisabled`
  (soft delete via `disabledAt`).

The `wildflower-host` first-party client is auto-seeded at startup by
calling `seedFirstPartyClient` once the LiveStore is ready, with
`kind: 'public'`, empty `redirectUris` (it gets tokens via the
[bootstrap URL](#bootstrap-url), not OAuth redirects), and
`allowedScopes: ['owner']`.

### AuthorizationRequest

A pending OAuth 2.0 authorization that has been started but not yet
resolved.

- **Table:** `authorizationRequests`
- **Discriminator:** `grantType: 'authorization_code' | 'device_code'`
  (matches the OAuth `grant_type` request parameter).
- **Status field:** `'pending' | 'approved' | 'denied' | 'expired'`.
- **TTL:** 5 minutes.
- **Identifier:** `id` (UUID — for code flow, the request id; for
  device flow, the `device_code`).
- **Device-flow extras:** `userCode` (the human-typed RFC 8628 §6.1
  code, formatted `BCDF-GHJK`); `lastPolledAt` (for the `slow_down`
  rate limit).

Code-flow rows carry the OAuth client's PKCE `code_challenge`,
`redirect_uri`, requested `scope`, and the `state` parameter. Device-flow
rows leave those columns null.

### AuthorizationCode

A single-use bearer credential issued **after** an
`AuthorizationRequest` (code flow only) is approved. The OAuth client
redeems it at `POST /oauth/token` to receive a JWT access token.

- **Table:** `authorizationCodes`
- **Identifier:** `code` (UUID, the primary key).
- **TTL:** 60 seconds from issuance.
- **Lifecycle:** issued by `authorizationCodeIssued`, deleted by
  `authorizationCodeConsumed` on every terminal token-exchange path
  (success, expiry, mismatch, verifier failure).

Device-flow does not use `AuthorizationCode`; the device-code branch of
`/oauth/token` reads the approval directly off `AuthorizationRequest`.

### Grant

A standing consent record: "OAuth client X is allowed to ask for scopes
Y at redirect URI Z without re-prompting the Owner." Used to fast-path
re-authorizations.

- **Table:** `grants`
- **Identifier:** plain string.
- **Indexed by:** `(clientId, redirectUri)` pair, queried via
  `byClientIdAndRedirectUri$`. Re-approval updates via `grantUpdated`
  rather than minting a duplicate row.
- **Scopes union across approvals** (gatekeeper-rust): a later approval
  merges its scopes into the standing grant — approving a narrower
  request never un-approves earlier consent. Revoking the grant is the
  way to withdraw consent (and also revokes the client's refresh
  tokens).
- **Key fields:** `clientId`, `scopes`, `redirectUri`, `grantedAt`,
  `lastUsedAt` (event slot reserved, materializer present, but **no
  consumer commits `clientAccessRecorded` yet**), `patient`
  (SMART-on-FHIR launch context).

Display name lives on [`Client`](#client)`.name`, not on `Grant`.

### SigningKey

An RSA 2048-bit JWK used to sign and verify gatekeeper-issued JWTs.
Public components are published at `/.well-known/jwks.json`.

- **Table:** `signingKeys`
- **Identifier:** `kid` (JWK key id, nanoid). Set on every signed
  JWT's protected header so verifiers can resolve the right key.
- **Algorithm:** RS256.
- **Active-key selection:** `isActive: boolean` column;
  `signingKeyActivated({ kid })` flips the named key on (and any
  prior active key off, in one materializer step). Sign-side picks
  via `SigningKey.queries.active$`. Verify-side iterates every key
  in the table — that's the rotation-safe path.

### Owner auth middleware (`RequireAuthMiddleware`)

The authorization wall on every Owner-facing JSON endpoint
(`/access/oauth-consents/*`, `/access/devices/*`, `/access/grants/*`,
`/access/requests/*`). Two-stage check:

1. `internal/jwt.ts:verifyJwt` validates the Bearer token (signature,
   `iss`, `aud`, `exp` — all enforced by `jose.jwtVerify`'s options),
   then looks up the JWT's `sub` in the [`clients`](#client) table.
   Disabled clients are rejected.
2. The middleware then enforces `'owner' ∈ payload.scope`. A
   third-party SMART client's token (with `patient/*.read` scope)
   verifies fine but doesn't pass this gate.

HTML pages in the `gatekeeper-pages` group do **not** carry this
middleware; they're public, and their JS gates UI client-side via the
Bearer token in `localStorage` (which it uses on the JSON endpoints
this middleware protects).

### Device flow (RFC 8628)

The first-party host browser's path to becoming an Owner-authenticated
client. Flow:

1. Browser POSTs `/oauth/device_authorization` with `client_id`. Server
   creates a `flow='device_code'` `AuthorizationRequest` and returns
   `{ device_code, user_code, verification_uri, ... }`.
2. Owner enters the `user_code` at `/gatekeeper/devices` (or scans the QR
   for `verification_uri_complete`) on a separate, already-Owner-authed
   device.
3. Owner approves via `POST /access/devices/:userCode/approve`.
4. Browser polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
   until status flips. Returns `authorization_pending` while waiting,
   `slow_down` if polled faster than the advertised `interval` (5s),
   `access_denied` / `expired_token` on terminal failure.

The device_code is single-use: the row's status flips to `expired` on
the first successful token mint so a second poll returns `expired_token`.

The `/access/devices/:userCode` consent routes (step 2/3) look a request up
by its short, human-typeable `user_code`, so that lookup is throttled per
client IP (10 attempts / 60s sliding window) to blunt brute-forcing of the
small code space; over-budget requests get `429` + `Retry-After`. The IP is
the tunnel-forwarded `x-forwarded-for` client when present, else the loopback
`ConnectInfo` peer — behind the loopback gate the peer alone is always
`127.0.0.1`. Distinct from the step-4 `slow_down` poll limit, which is per
device row, not per IP. Every Owner `/access/*` response is also
cache-suppressed (`Cache-Control: no-store` + `Pragma: no-cache`, since it
carries privileged consent/grant data) via a blanket layer that reuses the same
`CacheSuppressed` wrapper the `/oauth` token and device-authorization responses
pin per-response.

### Bootstrap URL

Replaces the deleted PIN flow's "operator gets onto a cold deployment"
mechanism. The host process (gatekeeper-node, native-shell wrapper, dev
server) has direct access to the signing key, mints a short-lived
access token via `internal/jwt.ts:mintAccessToken`, and hands the URL
to a browser. The browser's root shell consumes the token from a
`?token=` query param, stashes it in `localStorage`, and strips it
from the URL via `history.replaceState`.

The token verifies normally because `wildflower-host` is a registered
[`Client`](#client) and `'owner' ∈ scope`. No new endpoint, no
redemption table — the token's TTL (1 hour current dev default; the
long-term value is unsettled) plus the URL strip plus a
`Referrer-Policy: no-referrer` on static pages are the load-bearing
defenses against URL leakage.

### `gatekeeper-pages` group

The HttpApi group whose endpoints serve **HTML** to humans
(`OAuthPollingPage`, `OAuthConsentPage`, `DeviceEntryPage`,
`DeviceConsentPage`). Core ships definitions only; consumer slices
(`gatekeeper-react`) provide the handler layer through the phantom-id
bridge described in `docs/Effect/HttpApi Composition How-To.md`. Every
page is public; auth is JS-driven on the JSON endpoints behind them.

### `access-management`

The HttpApi group fronting the **Owner-facing** JSON endpoints under
`/access/...` — list/inspect/revoke `Grant`s, list/decide pending HTTP
requests. These all go through `RequireAuthMiddleware`.

### HTTP request gating (`httpRequests` table + `/access/requests`)

A separate, Gatekeeper-as-proxy concern: inbound HTTP requests are logged
to `httpRequests` and pause until the Owner approves or denies them.
**Not currently wired** — the table, queries, and `/access/requests`
endpoints exist but no producer pushes rows yet (see `await-row.ts`'s
`waitForRow` helper, which is the missing-call-site referenced in the
README).

> **Open question:** The HTTP-request gating flow shares the
> "row pending human decision" pattern with `AuthorizationRequest`.
> Candidate for folding the two together.

## OAuth 2.0 / OIDC spec terms

These are the IETF / OpenID terms that appear verbatim in the code or
URL params. Definitions paraphrased from the relevant RFCs; see "Where
it shows up" for the call sites.

### `client_id`

Identifier of the OAuth client. Form-supplied at `/oauth/authorize`,
`/oauth/token`, and `/oauth/device_authorization`. Every accepted value
must resolve to a row in [`clients`](#client). Unknown or disabled
clients are rejected at the boundary.

### `redirect_uri`

Where the OAuth client wants the authorization code delivered after
approval. Validated to be `http(s)` and to match an entry in the
client's `redirectUris` allowlist (exact match — no prefix games).

### `scope`

Space-delimited list of permission strings the OAuth client is asking
for. Capped per-client by `client.allowedScopes`; the request is
rejected if any requested scope falls outside. Stored on
`AuthorizationRequest.requestedScopes`,
`AuthorizationCode.grantedScopes`, and `Grant.scopes`.

### `state`

Opaque CSRF token chosen by the OAuth client. Echoed verbatim in the
final redirect. Not used by gatekeeper logic; persisted in the
`AuthorizationRequest.clientState` column so it survives the polling
round-trip.

### PKCE (`code_challenge`, `code_challenge_method`, `code_verifier`)

Proof Key for Code Exchange — RFC 7636. Defends against authorization-code
interception by binding the code to a high-entropy secret only the client
holds.

- **`code_verifier`** — random string the client generates and keeps.
  RFC 7636 §4.1 requires 43–128 characters; the schema enforces this
  via `Schema.minLength(43).pipe(Schema.maxLength(128))`.
- **`code_challenge`** — `BASE64URL(SHA-256(code_verifier))` per RFC 7636
  §4.2. Sent on `/oauth/authorize` and persisted on the
  `AuthorizationRequest` and `AuthorizationCode` rows.
- **`code_challenge_method`** — `S256` is the only value accepted.
  RFC 7636 also defines `plain` but we reject it.
- **Verification** — `internal/pkce.ts:computeCodeChallenge` recomputes
  the challenge from the verifier at token exchange and compares with
  `timingSafeEqual`.

### `iss` (issuer) and `aud` (audience)

JWT claims (RFC 7519 §4.1.1, §4.1.3) — _who_ minted this token and _for
whom_ it's intended. Today: `iss` is the `Origin` value (no path suffix);
`aud` is `${origin}/fhir` for tokens minted off the OAuth code flow and
just `origin` for tokens minted via the bootstrap URL.

A loose intuition: **`iss` is "who I am, the signer"; `aud` is "who I'm
talking to, the verifier."** A token signed for `aud=A` should not be
honored by `aud=B`, even if the signature is valid.

`verifyJwt` accepts either `origin` or `${origin}/fhir` as the audience.
Both checks are performed by `jose.jwtVerify`'s `{ issuer, audience }`
options — not by manual post-verify checks — so a future caller using
`SigningKey#verifyJwt` directly is forced to pass them and can't silently
accept any iss/aud.

### `sub` (subject)

JWT claim — _whom_ the token is about. Required to be a string; required
to resolve to a registered, enabled [`Client`](#client) row. The
[`clients`](#client) lookup is the authoritative gate that distinguishes
"valid token issued by this gatekeeper" from "valid signature but
not-our-issuer".

### `exp`, `iat`

JWT claim timestamps (Unix seconds). Both set by `mintAccessToken`; `exp`
is enforced by `jose.jwtVerify`'s default behavior.

### JWKS / JWK / `kid`

- **JWK** — a JSON-serialized cryptographic key (RFC 7517).
- **JWKS** — a JSON document at `/.well-known/jwks.json` listing this
  server's public verifying keys. The HttpApi group is named
  `oauth-discovery`.
- **`kid`** — JWK key id; the [SigningKey](#signingkey) primary key.
  Set on every signed JWT's protected header so multi-key verifiers can
  pick the right one without trying every key in the JWKS.

### Authorization code flow / `grant_type=authorization_code`

The standard OAuth 2.0 grant for browser-redirect flows. `/oauth/authorize`
requires `response_type=code` (RFC 6749 §4.1.1 makes the parameter
REQUIRED; `code` is the only value we implement — anything else is
rejected as `unsupported_response_type`). The `/oauth/token`
endpoint dispatches on `grant_type`; the `authorization_code` branch
verifies PKCE + redirect_uri + client_id match the issued code, then
mints a JWT.

### Device authorization flow / `grant_type=urn:ietf:params:oauth:grant-type:device_code`

RFC 8628. The grant type used by `wildflower-host` (and any other
no-redirect-capable OAuth client) to bootstrap onto a deployment. See
the [Device flow](#device-flow-rfc-8628) section above.

### Refresh token / `grant_type=refresh_token`

RFC 6749 §6, implemented in gatekeeper-rust with OAuth 2.1 rotation
semantics. Issued at `/oauth/token` only when the granted scopes include
`offline_access` (the SMART on FHIR convention).

- **Tables:** `refresh_token_families` holds the per-authorization facts
  (client, scopes, patient, deadline) exactly once; `refresh_tokens` holds
  one row per rotation, storing the SHA-256 base64url digest — never the
  plaintext.
- **Rotation:** each redemption consumes the presented token and returns
  its successor in the same family. Replaying a consumed token is treated
  as theft and revokes the whole family.
- **Lifetime:** the family has an absolute 90-day deadline
  (`REFRESH_TOKEN_FAMILY_TTL`) measured from the original authorization;
  rotation never extends it.
- **Revocation:** soft — killing a family (replay detection, or
  `DELETE /access/grants/{id}` revoking the client's standing consent)
  pulls the family's `expires_at` back to the revocation instant and
  stamps its live token consumed. Rows are never deleted, so the lineage
  stays auditable.

### Bearer token / `token_type=Bearer`

The single token-type literal we hand back at `/oauth/token`. RFC 6750
defines the `Authorization: Bearer <token>` header convention.
`RequireAuthMiddleware` consumes the header for Owner-facing endpoints.

### `.well-known`

URL-path convention from RFC 5785 for discovery endpoints. Today we host
JWKS at `/.well-known/jwks.json`. Future SMART-on-FHIR conformance will
also need `/.well-known/smart-configuration` and probably
`/.well-known/openid-configuration`.

### SMART-on-FHIR

The SMART App Launch profile of OAuth 2.0 used by FHIR servers
([HL7 spec](https://hl7.org/fhir/smart-app-launch/)). What gatekeeper is
imitating. Concretely it adds:

- `patient` launch context (carried on `AuthorizationCode.patient` and
  the access-token JWT's `patient` claim).
- Scope strings shaped like `patient/Observation.read`.
- The `aud` parameter on `/oauth/authorize` matching the FHIR base URL
  (`${origin}/fhir`).

## See-also: where these concepts may overlap

A short index of pairs/triples flagged with **Open question** above,
collected for the next round:

1. **AuthorizationCode ↔ AuthorizationRequest** — same row at different
   stages? Could be one table with a richer `status` discriminator.
2. **AuthorizationRequest ↔ HTTP request gate** — both are "row pending
   an Owner decision." Candidate for a shared `pendingApprovals` shape.

## References

- [README](../gatekeeper-core/README.md) — current tables and routes
- `slices/gatekeeper/gatekeeper-core/src/livestore/` — table definitions
- `slices/gatekeeper/gatekeeper-core/src/http-api-definition/` — endpoint groups
- RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7519 (JWT), RFC 7517 (JWK),
  RFC 6750 (Bearer), RFC 5785 (`.well-known`), RFC 8628 (Device
  Authorization Flow)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
