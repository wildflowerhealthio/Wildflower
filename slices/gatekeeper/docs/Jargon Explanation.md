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
issue **Grants** to OAuth Clients or to **Session** cookies requested
on a separate device, allowing them to access data in a system, and
possibly act as Owners.

## Roles

Three distinct human/machine roles whose names collide easily — get these
straight first.

| Role               | Who they are                                                                                                                 | Where they show up                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **OAuth client**   | Remote third-party app requesting access (the SMART-on-FHIR caller).                                                         | `client_id`, `redirect_uri`, `/oauth/...` endpoints                 |
| **Owner**          | Human with absolute control over the data this gatekeeper protects. Approves consent, verifies PINs, gates inbound requests. | `/access/...` endpoints, `RequireAuthMiddleware`, `Session` cookies |
| **Resource owner** | OAuth-spec name for the Owner — the person whose data is being shared.                                                       | OAuth spec only; we say "Owner"                                     |

> **Open question:** The OAuth `client` (third-party app) is unrelated to
> any LiveStore "client" instance — the word is overloaded. The spec name
> wins for `client_id`, but we should never use bare "client" in
> Gatekeeper prose without a qualifier.

## Slice-internal terms

These are the concepts named in `gatekeeper-core/src/livestore/` and
`gatekeeper-core/src/contexts/`. Each one corresponds to either a table,
an event, or a Tag.

### AuthorizationRequest

A pending OAuth 2.0 authorization that has been started but not yet
resolved. Created when an OAuth client hits `GET /oauth/authorize`.

- **Table:** `authorizationRequests`
- **Status field:** `'pending' | 'approved' | 'denied' | 'expired'`
- **TTL:** 5 minutes.
- **Identifier:** `requestId` (UUID).

The row carries everything the Owner needs to decide (client id, requested
scopes, code challenge, redirect URI, PKCE method, the OAuth `state`
parameter), plus a `preApprovedScopes` snapshot of any matching standing
[Grant](#grant) at the time the request was started.

### AuthorizationCode

A single-use bearer credential issued **after** an `AuthorizationRequest`
is approved. The OAuth client redeems it at `POST /oauth/token` to receive
a JWT access token.

- **Table:** `authorizationCodes`
- **Identifier:** `code` (UUID, the primary key).
- **TTL:** 60 seconds from issuance.
- **Lifecycle:** issued by `authorizationCodeIssued`, deleted by
  `authorizationCodeConsumed` on every terminal token-exchange path
  (success, expiry, mismatch, verifier failure).

> **Open question:** `code` is the primary key but `requestId` is also a
> column — the two ids cover the same logical row at different stages of
> the OAuth flow. Worth deciding whether code issuance should be modeled
> as a state transition on `AuthorizationRequest` rather than a separate
> table.

### Grant

A standing consent record: "OAuth client X is allowed to ask for scopes
Y at redirect URI Z without re-prompting the Owner." Used to fast-path
re-authorizations.

- **Table:** `grants`
- **Identifier:** plain string.
- **Indexed by:** `(clientId, redirectUri)` pair (no DB unique constraint
  yet, but this is the lookup the OAuth handler does).
- **Key fields:** `clientId`, `scopes`, `redirectUri`, `grantedAt`,
  `lastUsedAt` (event slot reserved, materializer present, but **no
  consumer commits `clientAccessRecorded` yet**), `label` (human-shown),
  `patient` (SMART-on-FHIR launch context).

> **Open question:** `Grant` carries client metadata (`clientId`, `label`)
> that more naturally lives on a future `Client` row. Issue #20 proposes
> splitting client identity out of `Grant` so `(clientId, redirectUri)`
> is validated against a registration before a grant is even possible.

### Session

A short-lived authenticated session for the **Owner** (not the OAuth
client). Created when a [PinChallenge](#pinchallenge) succeeds. The
session id reuses the challenge id so `/login/pin/:id/complete` can
find it.

- **Table:** `sessions`
- **Identifier:** plain string (no brand).
- **Duration:** `'request' | '1min' | '15min'` — chosen by the Owner on
  the PIN form. `'request'` = 30 seconds.
- **Backs:** the session JWT in the `__wildflower_session` cookie. The
  JWT `sub` matches the session row id.

### PinChallenge

An out-of-band login attempt for the Owner: a 6-digit PIN displayed on
one device, entered by the Owner on another device. Distinct from an
[AuthorizationRequest](#authorizationrequest) — a PIN never grants an
OAuth client access; it grants the **Owner themselves** a session to
act on the system.

- **Table:** `pinChallenges`
- **Identifier:** challenge id (UUID).
- **Status field:** `'pending' | 'verified' | 'rejected' | 'expired'`
- **TTL:** issued by `pin-login.ts`, expired by `cleanupExpiredPinChallenges`.
- **Brute-force protection:** `attempts` column; `MAX_PIN_ATTEMPTS = 5`
  flips the row to `rejected`.
- **PIN storage:** stored as `pinHash` (SHA-256 of `id:pin`); the event
  log never sees plaintext.

> **Open question:** `PinChallenge` and `AuthorizationRequest` share a
> shape: both are pending → approved/denied/expired records the Owner
> resolves at `/access/...`. The two flows already diverge at
> `oauth-consent` vs `pin-verification` HttpApi groups but the underlying
> "request awaiting human decision" abstraction could plausibly unify.

> **Open question:** The PIN flow is essentially a hand-rolled OAuth
> Device Authorization Flow (RFC 8628). Replacing it with the spec'd
> shape is under consideration — see the device-flow follow-up thread.

### SigningKey

An RSA 2048-bit JWK used to sign and verify gatekeeper-issued JWTs (both
access tokens and session cookies). Public components are published at
`/.well-known/jwks.json`.

- **Table:** `signingKeys`
- **Identifier:** `kid` (JWK key id, nanoid).
- **Algorithm:** RS256.
- **Selection:** `verifyJwt` tries every key in the table; signing today
  picks `[0]` (no concept of an "active" key — see issue #20).

### Owner auth middleware (`RequireAuthMiddleware`)

The authorization wall on every `/access/...` endpoint. Reads the
`__wildflower_session` cookie, verifies it as a session JWT, looks the
session up in the [`sessions`](#session) table. If the JWT is an
`access_token` JWT instead it falls through to the OAuth client path
(grants lookup).

> **Open question:** The same middleware accepts both session JWTs (from
> Owner login) and access-token JWTs (from OAuth-client tokens) by
> dispatching on `payload.type`. That makes "did this request come from
> a logged-in Owner" and "did this request come from a tokened OAuth
> client" indistinguishable to downstream handlers. They probably should
> be distinct middlewares.

### OAuthDisplayDefault

A `Context.Tag` carrying `'interactive' | 'out-of-band-polling'`. Decides
where `/oauth/authorize` redirects when the OAuth client did not pass
`?display=polling`:

- `'interactive'` → `/access/oauth-consents/:id/ui` (Owner clicks on
  same device).
- `'out-of-band-polling'` → `/oauth/authorize/:id/page` (browser shows
  pending page; Owner decides on a different device, browser polls
  status).

The URL param value is the public-facing literal `'polling'`; we translate
to the internal `'out-of-band-polling'` mode at the boundary.

### `display=polling`

Public OAuth-client query parameter on `/oauth/authorize`. Single
permitted value today (`'polling'`); switches the redirect target to the
out-of-band browser page regardless of the [OAuthDisplayDefault](#oauthdisplaydefault)
setting.

### Out-of-band approval

The whole UX shape this slice is built around: the OAuth client redirects
to a polling page that does **not** ask the Owner to consent in-place.
The Owner instead decides on a separate device through `/access/...`,
and the original browser polls `/oauth/authorize/:id` until it sees
`approved` and follows the carried redirect. See
`internal/out-of-band-approval.ts` for the `waitForRow` Effect helper
(5-min `ApprovalTimedOut`).

### `gatekeeper-pages` group

The HttpApi group whose four endpoints serve **HTML** to humans. Core
ships definitions only; consumer slices (`gatekeeper-web`) provide the
handler layer through the phantom-id bridge described in
`docs/Effect/HttpApi Composition How-To.md`. Operator-facing pages
under `/access/...` carry `RequireAuthMiddleware`; the polling/PIN
entry pages remain public (the requester has no session yet).

### `gatekeeper-access`

The HttpApi group fronting the **Owner-facing** JSON endpoints under
`/access/...` — list/inspect/revoke `Grant`s, list/decide pending HTTP
requests. These all go through `RequireAuthMiddleware`.

### HTTP request gating (`httpRequests` table + `/access/requests`)

A separate, Gatekeeper-as-proxy concern: inbound HTTP requests are logged
to `httpRequests` and pause until the Owner approves or denies them.
**Not currently wired** — the table, queries, and `/access/requests`
endpoints exist but no producer pushes rows yet (see `out-of-band-approval.ts`'s
`waitForRow` helper, which is the missing-call-site referenced in the
README).

> **Open question:** The HTTP-request gating flow is a third instance of
> the same "row pending human decision" pattern (after AuthorizationRequest
> and PinChallenge). If there's a future merge of those two, gated HTTP
> requests are a candidate to fold in too.

## OAuth 2.0 / OIDC spec terms

These are the IETF / OpenID terms that appear verbatim in the code or
URL params. Definitions paraphrased from the relevant RFCs; see "Where
it shows up" for the call sites.

### `client_id`

Identifier of the OAuth client (the third-party app). Form-supplied at
`/oauth/authorize` and `/oauth/token`. **Today there is no client
registration:** any string is accepted, no `redirect_uri` allowlist
exists, and `TokenExchange` does not authenticate `client_id`. That's
the design hole driving issue #20 (Clients table).

### `redirect_uri`

Where the OAuth client wants the authorization code delivered after
approval. Validated to be `http(s)` only. Not currently checked against
any per-client allowlist — see `client_id`.

### `scope`

Space-delimited list of permission strings the OAuth client is asking
for. Stored in `AuthorizationRequest.requestedScopes`,
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
- **`code_challenge`** — `BASE64URL(SHA-256(code_verifier))` per RFC 7636
  §4.2. Sent on `/oauth/authorize` and persisted on the
  `AuthorizationRequest` and `AuthorizationCode` rows.
- **`code_challenge_method`** — `S256` is the only value accepted.
  RFC 7636 also defines `plain` but we reject it.
- **Verification** — `internal/pkce.ts:computeCodeChallenge` recomputes
  the challenge from the verifier at token exchange and compares with
  `timingSafeEqual`.

> **Open question:** RFC 7636 §4.1 says `code_verifier` must be 43–128
> characters of unreserved chars; we accept any `NonEmptyString`.
> Issue #20 flag.

### `iss` (issuer)

JWT claim — who minted this token. Today: the `Origin` value (no path
suffix). The gatekeeper signs every JWT it issues; tokens are used
across multiple subsystems (FHIR, gatekeeper-access, future surfaces),
so the issuer doesn't bind to any one of them.

### `aud` (audience)

JWT claim — who this token is intended for. RFC 7519 §4.1.3: a token's
`aud` must match the verifier's identity, otherwise reject. Today
`verifyJwt` accepts either `origin` or `${origin}/fhir`.

A loose intuition: **`iss` is "who I am, the signer"; `aud` is "who I'm
talking to, the verifier."** A token signed for `aud=A` should not be
honored by `aud=B`, even if the signature is valid.

> **Open question:** We currently accept _both_ `origin` and
> `${origin}/fhir` as audiences. Once the Clients table (#20) lands,
> per-client audience policy can replace this loose acceptance.

### `sub` (subject)

JWT claim — _whom_ the token is about. Required to be a string. For an
`access_token` JWT, `sub` is the OAuth `client_id`. For a `session` JWT,
`sub` is the [Session](#session) id.

### `exp`, `iat`

JWT claim timestamps (Unix seconds). `exp` is enforced manually in
`verifyJwt`; `iat` is set by `signSessionJwt` and unused on verify.

### `type` (custom claim — not RFC 7519)

Our private claim that disambiguates session JWTs from access-token
JWTs:

- `type: 'access_token'` — `verifyJwt` looks `sub` up in `Grants`.
- `type: 'session'` — `verifyJwt` looks `sub` up in `Sessions`.

Anything else: reject.

### JWKS / JWK / `kid`

- **JWK** — a JSON-serialized cryptographic key (RFC 7517).
- **JWKS** — a JSON document at `/.well-known/jwks.json` listing this
  server's public verifying keys. The HttpApi group is named
  `oauth-discovery` (the JWKS endpoint sits under
  `/.well-known/jwks.json`); the file is `http-api-definition/jwks.ts`.
- **`kid`** — JWK key id; the [SigningKey](#signingkey) primary key.

### Authorization code flow / `grant_type=authorization_code`

The only OAuth grant type this server implements. The `/oauth/token`
endpoint requires `grant_type=authorization_code` in the form body.
Other RFC 6749 flows (client credentials, refresh tokens, password) are
not supported.

### Bearer token / `token_type=Bearer`

The single token-type literal we hand back at `/oauth/token`. RFC 6750
defines the `Authorization: Bearer <token>` header convention; we don't
parse Authorization headers ourselves yet — that's the consumer's job.

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
   stages? Could be one table with a `status: 'issued' | 'consumed'`
   transition.
2. **AuthorizationRequest ↔ PinChallenge ↔ HTTP request gate** — three
   instances of "row pending an Owner decision." Candidate for a shared
   `pendingApprovals` shape.
3. **Grant ↔ future Clients table** — `Grant` carries client metadata
   that wants to live on a `Client` row. See issue #20.
4. **`RequireAuthMiddleware`** — accepts both session and access-token
   JWTs by dispatching on `type`. Probably two middlewares, not one.
5. **PIN flow ↔ OAuth Device Authorization Flow (RFC 8628)** — the
   current PIN flow is a hand-rolled variant of the spec'd device flow.
   Replacing with RFC 8628 shape is under discussion.

## References

- [README](../gatekeeper-core/README.md) — current tables and routes
- `slices/gatekeeper/gatekeeper-core/src/livestore/` — table definitions
- `slices/gatekeeper/gatekeeper-core/src/http-api-definition/` — endpoint groups
- RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7519 (JWT), RFC 7517 (JWK),
  RFC 6750 (Bearer), RFC 5785 (`.well-known`), RFC 8628 (Device
  Authorization Flow)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
