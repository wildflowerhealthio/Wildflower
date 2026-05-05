# Plan: Clients table → Device flow → Cookie/Session removal

A single PR organized as a sequence of self-contained commits. The end
state collapses three things into one: any `client_id` is registered
(closes [#20](https://github.com/Assessment-is/Wildflower/issues/20));
the bespoke PIN flow is replaced by RFC 8628 Device Authorization Flow;
the cookie/session surface is gone in favor of Bearer-only auth.

The `wildflower-host` browser becomes a registered first-party public
OAuth client; an Owner gets onto a fresh deployment via a one-time
**bootstrap URL** carrying a short-lived access token, minted by the
host process directly from the signing key.

## End state

- One pending-decision table: `authorizationRequests`, used by both
  `authorization_code` and `device_code` grants.
- One auth surface: `Authorization: Bearer <token>` headers on `/access/*`
  API calls. Static HTML pages are public; their JS picks up the token
  from `localStorage` and gates UI client-side.
- No `pinChallenges`, no `sessions`, no `__wildflower_session` cookie,
  no `cookies.ts`, no `OAuthDisplayDefault` Tag, no `?display=polling`
  URL param, no `type` JWT claim, no display-mode policy on clients.
- One source of client policy: the `clients` table.
- One bootstrap path for getting an Owner a token: the host process
  mints an access token directly via `mintAccessToken`, hands the URL
  off to a browser. Same primitive serves dev mode, native-shell embed,
  CLI `login`, share-with-other-device, and test fixtures.

## Goals (definition of done)

- `clients` table; every `client_id` is rejected unless registered.
- Per-client `redirectUris` allowlist, `allowedScopes` cap, optional
  `secretHash` for confidential clients.
- `wildflower-host` registered as the first-party public client at
  startup.
- `mintAccessToken(activeKey, origin, { clientId, scope, ttlSeconds })`
  exported from `internal/jwt.ts`. Used by adapters to print bootstrap
  URLs.
- `/oauth/authorize` always redirects to the polling page; no interactive
  vs out-of-band-polling branch on the server side.
- Polling page JS does the same-device-vs-cross-device choice client-side
  by checking for a token in `localStorage`. With token: renders consent
  inline. Without: renders QR pointing at `/access/oauth-consents/:id/ui`.
- `POST /oauth/device_authorization` returns `{ device_code, user_code,
verification_uri, verification_uri_complete, expires_in, interval }`.
- `POST /oauth/token` accepts both `authorization_code` and
  `urn:ietf:params:oauth:grant-type:device_code` grants.
- `/access/devices` (Owner enters `user_code`) and
  `/access/devices/:userCode` (Owner approves/denies) endpoints exist.
- `pinChallenges`, `sessions`, `pin-login.ts`, `pin-verification.ts`,
  `pin-consent-decisions.ts`, `pin-hash.ts`, `cookies.ts`,
  `oauth-display-default.ts` all deleted.
- `RequireAuthMiddleware` only checks Bearer tokens; the redirect-to-login
  fallback (`requireAuthOrRedirect`) is gone.
- `verifyJwt` no longer dispatches on `type`; single token shape with
  `sub=client_id`. Token validity = signature + exp + iss + aud + `sub`
  is a registered, enabled `Client`. (Not "sub has a Grant" — that was
  conflating "consent recorded" with "token valid".)
- `RequireAuthMiddleware` additionally enforces `'owner' ∈ payload.scope`.
  A SMART third-party client's token (with `patient/*.read` scope) is a
  valid token but doesn't pass the `/access/*` gate.
- HTML pages in the `gatekeeper-pages` group are all public (no
  `RequireAuthMiddleware` on any of them); auth is JS-driven via Bearer.
- 8-letter QR-codeable `user_code` (RFC 8628 alphabet, formatted
  `BCDF-GHJK`).
- Tests cover: client lookup failures, scope cap, redirect-uri allowlist,
  device-flow happy + error paths (`authorization_pending`, `slow_down`,
  `access_denied`, `expired_token`), `user_code` brute-force counter,
  property tests for `user_code` alphabet and `mintAccessToken` round-trip.

## Non-goals

- Multi-tenant clients (single host, single Owner per deployment).
- Dynamic client registration (RFC 7591).
- Refresh tokens — Owner re-runs device flow when access token expires.
- A self-service Owner-registration UI.
- The full SMART-on-FHIR `.well-known/smart-configuration` document
  (separate ticket).
- A first-class redemption-code shape for the bootstrap URL — see
  "Trade-offs" at the bottom.

## Bootstrap mechanism (the new thing)

Replaces the previously-considered "setup mode" flag.

The host process — gatekeeper-node, the native-app shell embedding the
slice, or a dev `vp run dev` — has direct access to the signing key.
It mints a short-lived access token and hands it to a browser via URL.

```ts
// In gatekeeper-core/src/internal/jwt.ts:
const mintAccessToken = (
  signingKey: SigningKey,
  origin: string,
  payload: { clientId: string; scope: ReadonlyArray<string>; ttlSeconds: number }
): Effect.Effect<string, UnknownException>

// In an adapter (gatekeeper-node startup, or a CLI helper):
const token = yield* mintAccessToken(activeKey, origin, {
  clientId: 'wildflower-host',
  scope: ['owner'],
  ttlSeconds: 300,
})
console.log(`Open ${origin}/?token=${token}`)
```

Browser side, in the static landing page (gatekeeper-web):

```ts
// On page load, in the root app shell:
const url = new URL(window.location.href)
const token = url.searchParams.get('token')
if (token) {
  localStorage.setItem('wildflower-owner-token', token)
  url.searchParams.delete('token')
  history.replaceState(null, '', url.pathname + url.search)
}
```

The token is just a normal access token; `verifyJwt` accepts it because
`sub='wildflower-host'` is in `Clients` (config-seeded), and
`RequireAuthMiddleware` lets it through because `'owner' ∈ scope`. No
new endpoint, no redemption table.

**Defenses against URL leakage:**

- TTL: 5 minutes default. Captured URLs are valid only briefly.
- Strip from URL via `history.replaceState` immediately on first read.
  Token doesn't sit in the address bar or get propagated as `Referer`.
- Static pages set `Referrer-Policy: no-referrer`.
- (Optional follow-up, not in this PR) JTI tracking in livestore for
  true single-use semantics — overkill until we have a threat model
  that demands it.

**Use cases the same primitive serves:**

| Use case                                   | Producer                                              |
| ------------------------------------------ | ----------------------------------------------------- |
| First-Owner bootstrap on cold deployment   | Adapter prints URL at startup                         |
| Native-shell launch (React app in webview) | Native shell mints token, passes as initial URL       |
| Dev workflow (`vp run dev`)                | Dev script prints URL                                 |
| CLI `gatekeeper login`                     | CLI mints, opens via `xdg-open`/`open`                |
| Share-with-other-device                    | Owner clicks "share access" → server mints + emails   |
| Test fixtures                              | Tests mint directly without going through device flow |

`wildflower-host` registration in the `clients` table is still
config-seeded (the deployment supplies it). The bootstrap URL is for
handing an Owner a token _to_ the already-registered first-party client.

## Commit sequence (single PR)

### Commit 1 — Clients table + `mintAccessToken` + first-party host client

- Add `src/livestore/clients.ts`:

  ```ts
  clientId: text PK
  name: text
  kind: 'public' | 'confidential'
  redirectUris: json string[]   // exact-match allowlist
  allowedScopes: json string[]  // hard scope cap
  secretHash: text | null       // SHA-256, only for confidential
  registeredAt: DateTimeUtc
  disabledAt: DateTimeUtc | null
  ```

  Events: `clientRegistered`, `clientUpdated`, `clientDisabled`.

- Wire `/oauth/authorize` and `/oauth/token` against client lookup:
  - Reject unknown / disabled `client_id` (new error kinds in
    `internal/error-pages.ts`: `unknown_client`, `disabled_client`).
  - Reject `redirect_uri ∉ client.redirectUris`.
  - Reject `requested_scopes ⊄ client.allowedScopes`.
  - For confidential clients on `/oauth/token`: require `client_secret`
    - `timingSafeEqual` against `client.secretHash`.
- Wire `ApproveOAuthConsent` against client lookup:
  - Gate on `pending.status === 'pending'` (closes duplicate-grant hole).
  - Validate `payload.approvedScopes ⊆ pending.requestedScopes`
    (closes scope-escalation hole).
  - Replace `grantUpserted` with true upsert on `(clientId, redirectUri)`:
    query for existing grant, commit `grantUpdated` or `grantCreated`.
- Drop `Grant.label` column (display name lives on `Client.name`).
- Add `signingKeys.isActive: boolean` column. New event
  `signingKeyActivated`. Sign-side picks the active key; verify-side
  keeps trying all.
- Add `mintAccessToken` to `src/internal/jwt.ts`:

  ```ts
  const mintAccessToken = (
    signingKey: SigningKey,
    origin: string,
    payload: { clientId: string; scope: ReadonlyArray<string>; ttlSeconds: number }
  ): Effect.Effect<string, UnknownException>
  ```

  Single shape; no `type` claim.

- Update `verifyJwt` so it looks up `sub` in `Clients` (not `Grants`)
  for the `access_token` path. The previous "sub-in-Grants" check was
  a category error: it gated _token validity_ on whether _any
  consent record_ existed, which is a different question. Grants
  remain (they drive the `/oauth/authorize` skip-consent fast path),
  but token validity is independent of them. The `type='session'`
  branch stays untouched until commit 3 deletes it; the `type='access_token'`
  and no-`type` branches both go through the Clients lookup.
  (`mintAccessToken` emits no `type`; its tokens verify correctly from
  commit 1.)
- PKCE `code_verifier` length: `Schema.minLength(43).pipe(Schema.maxLength(128))`
  per RFC 7636 §4.1.

**Files touched:**

- `src/livestore/clients.ts` (new)
- `src/livestore/grants.ts` (drop `label`)
- `src/livestore/signing-keys.ts` (add `isActive`)
- `src/livestore/index.ts`
- `src/internal/jwt.ts` (add `mintAccessToken`)
- `src/internal/error-pages.ts` (new error kinds)
- `src/http-api-implementation/oauth.ts`
- `src/http-api-implementation/oauth-consent.ts`
- `tests/clients.test.ts` (new)
- `tests/oauth-endpoints.test.ts` (extend with allowlist/scope-cap/lookup cases)
- `tests/mint-access-token.test.ts` (new — round-trip with `verifyJwt`)

### Commit 2 — Device Authorization Flow (RFC 8628)

- Extend `src/livestore/authorization-requests.ts`:

  ```ts
  flow: 'authorization_code' | 'device_code' // NEW discriminator
  userCode: text | null // device flow only, "BCDF-GHJK"
  // existing fields stay; redirectUri / clientState / codeChallenge /
  // codeChallengeMethod become nullable for device-flow rows
  ```

  No `attempts` column. RFC 8628's `user_code` has ~10^10 entropy from
  the recommended alphabet; brute-forcing is infeasible without rate
  limiting, and `/access/devices/:userCode` requires Bearer (Owner)
  anyway. The PIN's brute-force counter was load-bearing for a 6-digit
  code; here it's not.

- Add `src/internal/user-code.ts`:
  - Alphabet `BCDFGHJKLMNPQRSTVWXZ` (RFC 8628 §6.1 recommendation).
  - 8 chars formatted `XXXX-XXXX`. ~1.6 × 10^10 entropy.
  - `crypto.getRandomValues` with rejection sampling against the
    alphabet length.
  - Collision check at issue time against `pending` rows.
- Add `POST /oauth/device_authorization`:
  - Form body: `client_id`, `scope`.
  - Validates `client_id` against `Clients`.
  - Issues `authorizationRequest` row with `flow='device_code'`, fresh
    `userCode`, fresh `id` (acts as `device_code`).
  - Response shape per RFC 8628 §3.2:

    ```json
    {
      "device_code": "<row id>",
      "user_code": "BCDF-GHJK",
      "verification_uri": "<origin>/access/devices",
      "verification_uri_complete": "<origin>/access/devices?user_code=BCDF-GHJK",
      "expires_in": 300,
      "interval": 5
    }
    ```

- Extend `POST /oauth/token` with a second branch:
  - `grant_type=urn:ietf:params:oauth:grant-type:device_code` +
    `device_code` + `client_id`.
  - Look up `authorizationRequests` row by id; check
    `flow='device_code'`, `clientId` matches.
  - Branch on status:
    - `pending` → `{ error: 'authorization_pending' }`, 400.
    - `denied` → `{ error: 'access_denied' }`, 400.
    - `expired` → `{ error: 'expired_token' }`, 400.
    - `approved` → mint access token (same shape as
      `authorization_code` branch), consume the row.
  - `slow_down` rate-limit lands in commit 4.
- Add `/access/devices` JSON group (Owner-facing):
  - `GET /access/devices/:userCode` — returns the pending request's
    requested scopes + client info. Auth required (Bearer with
    `'owner'` scope). 404 if no matching pending row.
  - `POST /access/devices/:userCode/approve` — Owner approves.
  - `POST /access/devices/:userCode/deny` — Owner denies.
- Add `/access/devices` HTML pages to the `gatekeeper-pages` group
  (definitions only; `gatekeeper-web` supplies handlers):
  - `GET /access/devices` — manual `user_code` entry form
    (the `verification_uri` users see on the device). Form submits
    to `/access/devices/:userCode/ui`.
  - `GET /access/devices/:userCode/ui` — Owner approval UI; reads
    `GET /access/devices/:userCode` and posts approve/deny via JS.
    Also the `verification_uri_complete` target (with `?user_code=`).
- Seed `wildflower-host` in the config-seeded clients list:

  ```ts
  {
    clientId: 'wildflower-host',
    name: 'Wildflower (host)',
    kind: 'public',
    redirectUris: [],
    allowedScopes: ['owner'],
    secretHash: null,
  }
  ```

**Files touched:**

- `src/livestore/authorization-requests.ts`
- `src/livestore/index.ts`
- `src/internal/user-code.ts` (new)
- `src/http-api-definition/oauth.ts` (add `DeviceAuthorization` endpoint)
- `src/http-api-implementation/oauth.ts`
- `src/http-api-definition/devices.ts` (new — JSON Owner endpoints)
- `src/http-api-implementation/devices.ts` (new)
- `src/http-api-definition/pages.ts` (add device-flow HTML pages)
- `tests/device-flow.test.ts` (new)
- `tests/user-code.test.ts` (new — property tests)

### Commit 3 — Drop PIN, sessions, cookies, display modes

The big delete. With the clients table and device flow live, the
bespoke PIN/session/cookie/display-mode surface is dead code.

**Deletes:**

- `src/livestore/pin-challenges.ts`
- `src/livestore/sessions.ts`
- `src/contexts/pin-consent-decisions.ts`
- `src/contexts/oauth-display-default.ts` (with both layers)
- `src/internal/pin-hash.ts`
- `src/internal/cookies.ts`
- `src/http-api-definition/pin-login.ts`
- `src/http-api-implementation/pin-login.ts`
- `src/http-api-definition/pin-verification.ts`
- `src/http-api-implementation/pin-verification.ts`
- `tests/pin-consent-decisions.test.ts`
- `cleanupExpiredPinChallenges` from `src/contexts/cleanup.ts`
  (auth-request and code cleanups stay)
- The `PinLoginPage` and `PinVerificationPage` entries from the
  `gatekeeper-pages` group
- `signSessionJwt` (replaced by `mintAccessToken` from commit 1)
- The `display=polling` URL param from `AuthorizeUrlParamsSchema`
- The interactive-vs-out-of-band-polling branch in `oauth.ts:Authorize`
  — always redirects to the polling page now

**Modifies:**

- `src/internal/jwt.ts` `verifyJwt`:
  - Drop the `type='session'` branch and the `type='access_token'`
    branch — both fold into a single path.
  - Single path: validate signature + exp + iss + aud + `sub` is a
    string + `sub` is a registered, enabled `Client`. Return the
    validated payload.
  - The `type` claim is gone from the verify side. (`mintAccessToken`
    already doesn't emit it; commit 1 already taught `verifyJwt` to
    accept tokens without a `type` claim.)
- `src/http-api-implementation/require-auth.ts`:
  - Drop `SessionCookieSecurity`.
  - Drop the cookie-fallback path.
  - Drop `requireAuthOrRedirect` (no more login-redirect; pages handle
    unauthenticated client-side via Bearer-presence check).
  - `RequireAuthMiddleware` only accepts `BearerTokenSecurity`.
  - Add `'owner' ∈ payload.scope` check after `verifyJwt` succeeds.
    Tokens issued to third-party SMART clients (with `patient/*.read`
    or similar) verify but are rejected at this gate. Without this
    check, any valid client token would unlock `/access/*`.
- `src/http-api-definition/require-auth.ts`:
  - Drop `SessionCookieSecurity` export.
- `src/http-api-definition/pages.ts`:
  - `OAuthConsentPage` loses its `RequireAuthMiddleware` (becomes
    public HTML). `PinVerificationPage` is deleted entirely. The
    device-flow pages added in commit 2 are also public.
  - All HTML pages in `gatekeeper-pages` are now public; auth is
    JS-driven via Bearer on the API calls the page makes. (The
    pages-need-middleware change from PR #19 was correct for the
    cookie world but wrong for the Bearer-only world; reverting here.)
- `src/livestore/index.ts` — drop `Sessions`, `PinChallenges` exports.
- `src/contexts/index.ts` — drop the `OAuthDisplayDefault` re-exports.
- `tests/oauth-endpoints.test.ts` — drop session-cookie cases.
- `tests/verify-jwt.test.ts` — drop `type='session'` cases; collapse
  `type='access_token'` cases to "JWT verified, sub looked up in Grants".
- `gatekeeper-web` adapter (separate concern, follow-up to this PR):
  - Drops PIN page handlers from the page contract.
  - Adds JS to root shell that consumes `?token=...`, stashes in
    localStorage, strips from URL.
  - Polling page JS does the localStorage check: present → fetch
    `/access/oauth-consents/:id` with Bearer + render consent inline;
    absent → render QR pointing at `/access/oauth-consents/:id/ui`.

### Commit 4 — Polish

- Move `/oauth/token` body parsing into the route definition via
  `HttpApiSchema.withEncoding({ kind: 'UrlParams', contentType:
'application/x-www-form-urlencoded' })`. Both grant-type branches
  now have typed payloads. (Resolves the deferred PR #19 thread.)
- Replace remaining `unsafeJson` with `addError`-typed responses in
  `oauth.ts` and `devices.ts`. (Resolves the other deferred PR #19
  thread.)
- `slow_down` rate-limit on `/oauth/token` device-code branch. Track
  last-poll timestamp on the row; return `slow_down` if poll faster
  than advertised `interval`.
- Property tests:
  - `user_code` alphabet uniqueness over 10^6 generations.
  - `computeCodeChallenge` is base64url; RFC 7636 §A.1 known-answer.
  - `timingSafeEqual(a, b) === (a === b)` over arbitrary inputs.
  - `mintAccessToken → verifyJwt` round-trip preserves payload.
- Coverage for `verifyJwt` rejection branches: expired exp, wrong iss,
  wrong aud, multi-key rotation.
- TokenExchange's six 4xx branches and the 500 "no JWKs" branch get
  explicit tests.

## Schema after the PR

```text
clients               (NEW in commit 1)
authorizationRequests (extended in commit 2; absorbs PinChallenge role)
authorizationCodes    (unchanged)
grants                (label dropped in commit 1)
signingKeys           (isActive added in commit 1)
httpRequests          (unchanged)

DROPPED in commit 3:
  pinChallenges
  sessions
```

## Endpoint map after the PR

```text
Public (HTML; no server-side auth — JS gates via Bearer):
  GET  /                                (root shell; consumes ?token=)
  GET  /oauth/authorize/:id/page        (browser polling page)
  GET  /access/oauth-consents/:id/ui    (Owner consent UI; QR target)
  GET  /access/devices/:userCode/ui     (Owner device-approval UI; QR target)

Public (JSON, no auth):
  GET  /.well-known/jwks.json
  GET  /oauth/authorize                 (OAuth code flow start)
  GET  /oauth/authorize/:id             (polling status)
  POST /oauth/device_authorization      (device flow start)
  POST /oauth/token                     (both grant types)

Owner-only (Bearer required):
  GET  /access/oauth-consents/:id       + POST /approve, /deny
  GET  /access/devices/:userCode        + POST /approve, /deny
  GET  /access/grants                   + GET /:id, DELETE /:id
  GET  /access/requests                 + GET /:id, /approve, /deny

DROPPED:
  /login/pin*
  /access/pin-verifications/*
```

## JWT shape after the PR

Single token type. No `type` claim.

```json
{
  "iss": "<origin>",
  "sub": "<client_id>",
  "aud": "<origin>",
  "exp": "<unix seconds>",
  "iat": "<unix seconds>",
  "scope": "<space-separated granted scopes>",
  "patient": "<optional SMART launch context>"
}
```

`verifyJwt`: signature valid, exp not past, iss matches origin, aud
in accepted set, `sub` is a string and a registered, enabled
`Client`. Returns the validated payload.

`RequireAuthMiddleware`: runs `verifyJwt`, then checks
`'owner' ∈ payload.scope`. The two-stage check is intentional —
`verifyJwt` answers "is this a valid token issued by us"; the scope
check answers "is this token authorized for the Owner gate".

The first-party host's "session" is just an access token issued to
`wildflower-host` with `scope: ['owner']`. Whether you got it via
device flow or via `mintAccessToken` bootstrap URL is invisible after
the fact. A third-party SMART client's access token has the same
shape but `scope: ['patient/Observation.read']` (or similar); it
verifies fine but doesn't pass the `'owner'` gate.

## Tests after the PR

- `tests/clients.test.ts` (commit 1)
- `tests/mint-access-token.test.ts` (commit 1)
- `tests/oauth-endpoints.test.ts` — extended through every commit
- `tests/oauth-consent-decisions.test.ts` — extended in commit 1 with
  status-gate and scope-subset cases
- `tests/device-flow.test.ts` (commit 2)
- `tests/user-code.test.ts` (commit 2)
- `tests/verify-jwt.test.ts` — `type` claim removed in commit 3;
  rejection branches added in commit 4
- `tests/out-of-band-approval.test.ts` (unchanged)
- `tests/index.test.ts` (re-exports, drops PIN entries)
- `tests/timing-safe-equal.test.ts` — property tests (commit 4)
- `tests/pkce.test.ts` — property tests (commit 4)

Deletes: `tests/pin-consent-decisions.test.ts` (commit 3).

## Adapter / config-seeded clients

Adapter slices (`gatekeeper-node`, native-shell wrappers) read a config
file at startup and commit `clientRegistered` events for any client not
already present. Mandatory entry: `wildflower-host`. Optional: any
SMART third-party clients the deployment expects.

The bootstrap URL is independent of config-seeding — it's the runtime
hand-off that gives an Owner a token _to_ the already-registered
`wildflower-host` client.

## Trade-offs and open questions

- **Token in URL** (chosen) vs redemption-code-in-URL — direct token is
  simpler (no new endpoint, no new table); short TTL (5 min) +
  `history.replaceState` strip + `Referrer-Policy: no-referrer` are the
  load-bearing defenses. JTI single-use tracking is a deferred
  follow-up if a real threat model demands it.
- **`returnTo` is gone.** The PIN flow's `returnTo` carry-along has no
  device-flow analog. The host browser knows its own state and resumes
  locally. If a deep-link-into-host use case ever shows up, we'd add
  a `state`-style param to the `mintAccessToken` URL.
- **`OAuthDisplayDefault`** Tag deletion turns the same-device vs
  cross-device choice into a JS check on the polling page. The Tag,
  the two layers, and the `?display=polling` URL param all leave the
  codebase. The `gatekeeper-pages` group's `RequireAuthMiddleware`
  additions from PR #19 also revert — pages are public.
- **`HttpRequest` gating** stays as-is. Separate concern; the
  `/access/requests` endpoints still exist and still need a
  `waitForRow` consumer.
- **Refresh tokens.** Out of scope. Owner re-runs device flow (or the
  host emits a fresh bootstrap URL) when an access token expires.
  Default TTL: 1h. Revisit if Owner re-login is too painful in
  practice.
- **`scope='owner'`** is doing all the work as the single first-party
  scope, gating every `/access/*` endpoint. Sliced scopes
  (`grants:read`, `grants:write`, `requests:approve`) are deferable;
  fold in when the Owner UI surface grows enough to warrant
  finer-grained tokens (e.g. for share-with-other-device with
  read-only access).
- **One row table for both grant types.** Most columns are nullable
  for device-flow rows. If this gets unwieldy we can split later, but
  today the shapes overlap enough that one table is right.
- **PR #19 in-flight changes**: the `gatekeeper-pages` middleware
  addition and the PIN-hash work both get reverted by commit 3. Both
  served as correct intermediate states; the rework supersedes.
