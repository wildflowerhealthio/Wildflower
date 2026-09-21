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
onto a fresh deployment via the RFC 8628 device authorization flow; an
on-device shell (embedded/Tauri) instead receives a host-minted token
directly (see [bootstrap URL](#bootstrap-url)).

## Roles

Three distinct human/machine roles whose names collide easily — get these
straight first.

| Role               | Who they are                                                                                                  | Where they show up                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **OAuth client**   | Remote app requesting access (the SMART-on-FHIR caller, or `wildflower-host` itself).                         | `client_id`, `redirect_uri`, `/oauth/...` endpoints, the [`clients`](#client) table  |
| **Owner**          | Human with absolute control over the data this gatekeeper protects. Approves consent, gates inbound requests. | `/access/...` endpoints, `RequireAuthMiddleware`, Bearer tokens with `'owner'` scope |
| **Resource owner** | OAuth-spec name for the Owner — the person whose data is being shared.                                        | OAuth spec only; we say "Owner"                                                      |

> **Open question:** The OAuth `client` (third-party app) is unrelated to
> HTTP-client instances in the codebase — the word is overloaded. The
> spec name wins for `client_id`, but we should never use bare "client"
> in Gatekeeper prose without a qualifier.

## Slice-internal terms

These are the concepts stored by `gatekeeper-rust` and named in
`gatekeeper-core/src/contexts/`. Each one corresponds to either a table,
an event, or a Tag.

### Client

A registered OAuth client. Every `client_id` accepted on `/oauth/token` or
`/oauth/device_authorization` must resolve to a row in this table — unknown
ids are rejected at the boundary. `/oauth/authorize` is the exception: an
unknown `client_id` (or a known one whose request steps outside its
registration) is carried to the Owner's consent prompt with a warning, and
the row is created or widened only when the Owner approves — see
[Trust on first use](#trust-on-first-use).

- **Table:** `clients`
- **Identifier:** `clientId` (string PK, not a generated id — the
  registrar supplies it).
- **Kind:** `'public' | 'confidential'`. Confidential clients carry a
  `secretHash` (SHA-256) and must present `client_secret` on
  `/oauth/token`, verified by `timingSafeEqual`.
- **Allowlists:** `redirectUris` (exact match) and `allowedScopes`
  (what this client may request without the Owner being warned). For every
  client but `wildflower-host` these are the _registered_ set, not a hard
  cap: a request outside them reaches consent as a
  [registration verdict](#trust-on-first-use) of `changed`, and approval
  widens the row.
- **Lifecycle:** `clientRegistered` → `clientUpdated` → `clientDisabled`
  (soft delete via `disabledAt`).

The `wildflower-host` first-party client (`FIRST_PARTY_CLIENT_ID`) is
auto-seeded by the server at startup, with
`kind: 'public'`, empty `redirectUris` (it gets its token via the device
flow or a host mint — see [bootstrap URL](#bootstrap-url) — not OAuth
redirects), and `allowedScopes: ['owner']`.

### Trust on first use

`/oauth/authorize` compares an authorization-code request against the
current [`clients`](#client) row and computes a **registration verdict**:

- **`registered`** — the row exists, the `redirect_uri` resolves to an
  allowlist entry, and every requested scope is covered by `allowedScopes`.
  Only this verdict may take the existing-[`Grant`](#grant) fast path.
- **`new`** — no row exists. The consent prompt names the app by its
  `client_id` and shows the redirect origin.
- **`changed`** — the row exists but the `redirect_uri` is not allowlisted
  and/or some requested scopes (`newScopes`) fall outside `allowedScopes`.

The verdict is computed at read time (both at `/authorize` and on
`GET /access/oauth-consents/:id`, which returns it as `registration`), never
stored, so two prompts for the same app agree with whatever the row says
now. Nothing is persisted for a `new` client until approval; a denied or
expired prompt leaves no trace of it.

Approving a `new` or `changed` prompt requires the Owner's explicit
`acknowledgedRegistration` (the consent UI's "I recognise this app and this
redirect address" checkbox) — the server rejects the approval without it.
On approval the row is created (`kind: 'public'`, every grant type, name
equal to the `client_id`, the one redirect, the granted scopes) or widened:
the exact `redirect_uri` is added to `redirectUris` and the **granted** (not
requested) scopes widen `allowedScopes`, so a later identical request is
`registered` and fast-paths. The clamp on such an approval is
`allowedScopes ∪ requestedScopes`; the approving Owner still cannot delegate
a scope they do not hold themselves.

That widening is by scope, not by string (`scopes_rust::widened_scopes`):
granting `patient/Patient.cruds` over a registered `patient/Patient.r`
records the one broader scope instead of both spellings, and `.r` plus a
later `.s` is recorded as `.rs`. A row created by a first approval and one
widened into the same state are byte-identical. See
[Grant](#grant) for the same rule on the standing consent.

While the redirect is untrusted (verdict `new`, or `changed` with a new
redirect) every later validation failure at `/authorize` — bad scheme,
non-`code` `response_type`, bad PKCE — renders the local error page rather
than redirecting, exactly as an unknown client's failure does on the other
endpoints (RFC 6749 §4.1.2.1's open-redirect rule). Scope strings are not
validated against a grammar on this path: an unparseable scope is carried to
the prompt as an opaque named scope that matches only itself.

The first-party `wildflower-host` client is exempt: an unregistered redirect
or scope for it is rejected at the boundary, and approval never widens its
row. Disabled clients are rejected on every endpoint regardless of verdict.

> **Trade-off:** any page can present a _known_ `client_id` with its own
> redirect, and the Owner sees a `changed` prompt under a trusted app's name.
> The prompt's prominent redirect origin and the acknowledgment checkbox are
> the mitigation; the Owner is the trust anchor, as with any TOFU scheme.
> The device flow stays strict.

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
  rate limit); `deviceName` (see [Device name](#device-name)).

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
- **The union is by scope, not by string** (`scopes_rust::widened_scopes`):
  consenting to `patient/Patient.cruds` over a standing
  `patient/Patient.r` records the one broader scope rather than both
  spellings, and `.r` plus a later `.s` is recorded as `.rs`. The
  widened list still reaches every interaction it reached before — only
  the spelling is shortened. A v1 word scope (`.read`) is never folded
  into a v2 letter bag, which would hand the client letter-grammar
  access it was never granted.
- **The fast path matches by coverage**, the same
  `allowed_scope_covers` test `Client.allowedScopes` is read through:
  a standing consent to `patient/Observation.rs` pre-approves a later
  request for the narrower `patient/Observation.r`.
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
middleware; they're public. The web SPA derives its auth state from the
readable `wf_auth_exp` cookie and authenticates the JSON endpoints this
middleware protects via the `HttpOnly` `wf_auth` cookie; the embedded/Tauri
SPA sends an `Authorization: Bearer` header from its host-provided token
instead.

### Device flow (RFC 8628)

The first-party host browser's path to becoming an Owner-authenticated
client. Flow:

1. On the device-login screen the user names the device and adjusts a scope
   request with the shared scope picker (see [Device name](#device-name) and
   [Expandable consent](#expandable-consent)), then starts sign-in. The picker
   is pre-seeded with the read+search happy path (`system/*.rs wildflower/*.rs`)
   when the client's allowed set covers it, so the common case is
   name-it-and-go. The browser
   POSTs `/oauth/device_authorization` with `client_id`, the built `scope`, and
   the chosen `device_name`. Server creates a `flow='device_code'`
   `AuthorizationRequest` and returns `{ device_code, user_code, verification_uri, ... }`.
2. Owner enters the `user_code` at `/gatekeeper/devices` (or scans the QR
   for `verification_uri_complete`) on a separate, already-Owner-authed
   device.
3. Owner reviews the request (device name + requested scopes) and approves via
   `POST /access/devices/:userCode/approve`. The Owner may add scopes beyond
   what the device requested (up to the client's `allowedScopes`) or prune them
   — see [Expandable consent](#expandable-consent) — and, from the settings
   surface, adjust the device name.
4. Browser polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
   until status flips. Returns `authorization_pending` while waiting,
   `slow_down` if polled faster than the advertised `interval` (5s),
   `access_denied` / `expired_token` on terminal failure.

The device_code is single-use: the row's status flips to `expired` on
the first successful token mint so a second poll returns `expired_token`.

### Device name

A human-chosen label for the device being paired ("Ada's laptop"), distinct from
the OAuth [client](#client) name (all first-party devices share the
`wildflower-host` client, so the client name can't tell them apart). A
non-standard RFC 8628 extension: the requesting device sends it as the
`device_name` form field on `/oauth/device_authorization`; it is stored on the
device-flow [`AuthorizationRequest`](#authorizationrequest), surfaced to the
Owner on the consent prompt, and — from the settings consent surface — editable
before approval (persisted `COALESCE`-style, so an omitted value keeps the stored
one).

When the device doesn't send a name, the server infers a friendly one from the
request's `User-Agent` (e.g. `"Chrome on macOS"`) — only as a fallback, never
overriding a name the device or Owner chose. Unrecognizable User-Agents (the
many non-browser device-code clients — CLIs, TV apps, bare HTTP libraries) infer
nothing; the effective name then falls back to the client name at grant-mint
time so the durable device grant's `(client_id, device_name)` key stays total.
Optional on the wire; auth-code requests carry no device name.

### Expandable consent

The device-code consent path is **expandable**: the Owner may grant scopes the
device did **not** request, up to the client's `allowedScopes`, as well as narrow
what was asked. This contrasts with the **clamped** authorization-code / app
consent path, where the grant may only be narrowed within the requested set
(`granted ⊆ requested`) — a third-party app can never widen its own grant. The
distinction lives in the two approve handlers' clamp: the device path measures
`grantable_scopes` against `client.allowedScopes`; the code path measures it
against the request's `requestedScopes`. The shared scope-picker UI models the
same split with its `expandable` vs `clamped` mode.

### Bootstrap URL

Replaces the deleted PIN flow's "operator gets onto a cold deployment"
mechanism. The host process (`gatekeeper-rust`, native-shell wrapper, dev
server) has direct access to the signing key and mints a short-lived owner
access token directly. It verifies normally
because `wildflower-host` is a registered [`Client`](#client) and
`'owner' ∈ scope` — no new endpoint, no redemption table.

The web SPA has no client-side URL-token consumption: its access token is
the `HttpOnly` `wf_auth` cookie the server sets at token issuance, which JS
can't plant from a `?token=` param. So a cold _web_ deployment is entered
through the device flow; reviving a URL bootstrap would take a small server
endpoint that accepts the minted token and sets the cookie. The
embedded/Tauri path receives the host-minted token over the gatekeeper
bridge instead.

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
**Not currently wired** — the `/access/requests` endpoints are defined
but no producer pushes rows yet.

> **Open question:** The HTTP-request gating flow shares the
> "row pending human decision" pattern with `AuthorizationRequest`.
> Candidate for folding the two together.

## OAuth 2.0 / OIDC spec terms

These are the IETF / OpenID terms that appear verbatim in the code or
URL params. Definitions paraphrased from the relevant RFCs; see "Where
it shows up" for the call sites.

### `client_id`

Identifier of the OAuth client. Form-supplied at `/oauth/authorize`,
`/oauth/token`, and `/oauth/device_authorization`. On the latter two every
accepted value must resolve to a row in [`clients`](#client); on
`/oauth/authorize` an unknown value reaches consent as a `new`
[registration verdict](#trust-on-first-use). Disabled clients are rejected
everywhere.

### `redirect_uri`

Where the OAuth client wants the authorization code delivered after
approval. Validated to be `http(s)`; matched against the client's
`redirectUris` allowlist (exact match — no prefix games). A miss is not a
rejection but a `changed` [registration verdict](#trust-on-first-use)
(`wildflower-host` excepted), and until the Owner approves, the URI is
untrusted — no error redirects to it.

### `scope`

Space-delimited list of permission strings the OAuth client is asking
for. Compared against `client.allowedScopes`; a scope outside that set makes
the request a `changed` [registration verdict](#trust-on-first-use) that the
Owner is warned about (`wildflower-host` excepted — its requests are
rejected with `invalid_scope`). Stored on
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
just `origin` for host-minted owner tokens.

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

JWT claim timestamps (Unix seconds). Both set at token minting; `exp`
is enforced at verification.

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

### Access-token revocation (`jti` denylist + subject epoch)

Refresh-token revocation (above) stops a client minting _new_ access tokens;
this stops an _already-issued, still-unexpired_ access token — the leaked-cookie
case (#218/#269). Every minted access token now carries a unique `jti` (RFC 7519
§4.1.7), which is a **revocation handle, not a single-use nonce** — normal reuse
of the one multi-use bearer is untouched. The shared store (`token-revocation-rust`,
its own `token_revocation` migration namespace on the same database) holds two
levers:

- **`revoked_jtis`** — a per-token denylist. `POST /access/revocations` with a
  `jti`, and logout of the presented token, add rows here.
- **`revocation_epochs`** — a per-subject `not_before`. Bumping it (via
  `POST /access/revocations` with a `subject`, or a grant revoke) invalidates
  every token that subject holds whose `iat` predates the bump — cheap bulk
  revocation with no per-issued-`jti` registry. `subject` is the `sub` claim
  (today the `client_id`), so revocation is per-client; per-device needs a
  device handle in the token (future work).

A token is **revoked** iff its `jti` is denylisted **or** its `iat` predates its
subject's epoch. The auth gate (`verify_auth_token_claims`) runs the full check
on every Owner-gated and every `/fhir-r4/*` request; HFS additionally checks the
per-`jti` denylist in-process (defense-in-depth). Expired denylist rows are swept
at startup and daily. See `docs/Origins/Explanation.md` for how this composes
with the served-origin model.

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
- `slices/gatekeeper/gatekeeper-rust/src/` — server implementation and storage
- `slices/gatekeeper/gatekeeper-core/src/http-api-definition/` — endpoint groups
- RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7519 (JWT), RFC 7517 (JWK),
  RFC 6750 (Bearer), RFC 5785 (`.well-known`), RFC 8628 (Device
  Authorization Flow)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
