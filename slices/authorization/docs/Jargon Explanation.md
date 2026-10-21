# Wildflower Authorization Jargon Explanation

This doc fixes the meaning of every domain term that appears in the
`authorization` slice — internal vocabulary first, then the OAuth 2.0 / OIDC
spec terms that show up in the code. The goal is to surface concepts that
overlap so a future round can decide whether to merge or rename them.

Everything here is **descriptive of the code as it stands today**. Open
questions about whether two concepts should collapse are flagged with
**Open question:** callouts.

## What the authorization server is for

Wildflower Authorization allows an authorized **Owner** on one device to
issue **Grants** to OAuth Clients (registered in the
[`clients`](#client) table) requesting access on a separate device,
allowing them to access data in a system. The
[Wildflower host app](#wildflower-host-app) holds no token: it acts as the
Owner in process, and signs browsers on its own device in as the Owner (see
[Same-device sign-in](#same-device-sign-in)).

## Roles

Distinct human/machine roles whose names collide easily — get these straight
first. "Host" alone is ambiguous (the host app, the HTTP `Host` header, the
`__Host-` cookie prefix), so these docs say **Wildflower host app**.

| Role                    | Who they are                                                                                                                  | Where they show up                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **OAuth client**        | Remote app requesting access (the SMART-on-FHIR caller, or the Wildflower host app itself).                                   | `client_id`, `redirect_uri`, `/oauth/...` endpoints, the [`clients`](#client) table       |
| **Owner**               | Human with absolute control over the data this authorization server protects. Approves consent, gates inbound requests.       | `/authorization/...` endpoints, `RequireAuthMiddleware`, tokens holding the Owner's grant |
| **Wildflower host app** | The app on the Owner's device that runs this server in its own process. See [Wildflower host app](#wildflower-host-app).      | The host app's client (`WILDFLOWER_HOST_APP_CLIENT_ID`), the in-process consent decider   |
| **Signed-in browser**   | A browser the server has signed in: the Owner's on the same device, or a paired one. See [Browser session](#browser-session). | The browser-session client, the `__Host-browser_session` cookie                           |
| **Resource owner**      | OAuth-spec name for the Owner — the person whose data is being shared.                                                        | OAuth spec only; we say "Owner"                                                           |

> **Open question:** The OAuth `client` (third-party app) is unrelated to
> HTTP-client instances in the codebase — the word is overloaded. The
> spec name wins for `client_id`, but we should never use bare "client"
> in Wildflower Authorization prose without a qualifier.

## Slice-internal terms

These are the concepts stored by `authorization-server-rust` and named in
`authorization-core/src/contexts/`. Each one corresponds to either a table,
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
  client but the [Wildflower host app](#wildflower-host-app)'s these are the _registered_ set, not a hard
  cap: a request outside them reaches consent as a
  [registration verdict](#trust-on-first-use) of `changed`, and approval
  widens the row.
- **Lifecycle:** registered (seeded by a migration or at boot, or created
  by [trust on first use](#trust-on-first-use)) → widened (a later TOFU
  approval) → disabled / re-enabled by the Owner. Disabling is a soft switch
  on `disabledAt`: the row, its allowlists, and its secret are kept. While
  `disabledAt` is set, every OAuth endpoint refuses the client:
  `/oauth/authorize` renders the local "Disabled client" page, and client
  authentication at `/oauth/token` and `/oauth/device_authorization` fails
  with `invalid_client`. Re-enabling clears the stamp and the client works
  again exactly as registered.
- **Owner management:** `GET /authorization/clients` lists every row (never the
  secret hash) with an `essential` flag. `PATCH /authorization/clients/:clientId`
  with `{ "disabledAt": … }` answers with the updated row and sets the stamp
  as follows:
  - any UTC time disables the client now, stamped with the server's own
    now whatever time was sent. A disable can be neither scheduled nor
    backdated. Wildflower Authorization sends its current time.
  - `null` re-enables the client.
  - a client that already has a `disabledAt` keeps it. The update is
    idempotent, and a repeated disable doesn't move the time.

  An unknown `clientId` is a 404. The routes are gated on
  `wildflower/Client.r` (list) and `wildflower/Client.u` (the `PATCH`). The
  Wildflower Authorization app (`apps/authorization/authorization-web`) shows
  them as the "Trusted Apps" list on its access page.
  Disabling leaves the client's [grants](#grant) and
  refresh-token families in place — unusable while it's disabled, live again
  once it's enabled; revoke a grant to end it for good.

Two clients are seeded by the server at startup, both `kind: 'public'` with
empty `redirectUris`:

- `WILDFLOWER_HOST_APP_CLIENT_ID`, named `Wildflower Host`, the
  [Wildflower host app](#wildflower-host-app)'s. It is allowed only its own
  scopes (`host_app_client_scopes`, `openid`), not the Owner's. The host app holds
  no token of its own (see [Wildflower host app](#wildflower-host-app)).
- `BROWSER_SESSION_CLIENT_ID`, named `Wildflower Browsers`, the client every
  [browser session](#browser-session)'s token is issued to, allowed the
  Owner's scopes (`OWNER_SCOPES`). It is allowed no grant type: its tokens are
  minted only at `/oauth/sign-in`. Revoking its subject signs every browser
  out.

Both are [essential clients](#essential-client), which can't be disabled.

### Essential client

A client the Owner can't lose without being stuck: the
[Wildflower host app](#wildflower-host-app)'s, which is how
the Owner reaches the server at all, and the browser-session client
(`BROWSER_SESSION_CLIENT_ID`), which every [browser session](#browser-session)'s
token is issued to. Disabling either would leave the Owner no way in, so a
`PATCH /authorization/clients/:clientId` that sets a `disabledAt` on one is
refused with a `409 EssentialClient`, and nothing is written. Re-enabling one
stays allowed, so an essential client disabled out of band (direct SQL) can be
recovered; while the browser-session client is disabled that way,
`/oauth/sign-in` signs no browser in and `/oauth/pair` starts no
[browser pairing](#browser-pairing). `GET /authorization/clients` flags both
`essential`, and the "Trusted Apps" list offers them no switch. The rule lives
in one place, `is_essential_client`, which the client reader and disabler
share.

### Trust on first use

An authorization-code request **presents** a client registration: its
`client_id`, `redirect_uri`, and scopes (`PresentedClientRegistration` in
Rust). `/oauth/authorize` judges whether to accept it as it stands against
the current [`clients`](#client) row, and computes a **registration verdict**
(`PresentedClientChange` in Rust):

- **`registered`** — the row exists, the `redirect_uri` resolves to an
  allowlist entry, and every requested scope is covered by `allowedScopes`.
  Only this verdict may take the existing-[`Grant`](#grant) fast path.
- **`new`** — no row exists. The consent prompt names the app by its
  `client_id` and shows the redirect origin.
- **`changed`** (`WouldWiden` in Rust) — the row exists but the
  `redirect_uri` is not allowlisted and/or some requested scopes (`newScopes`)
  fall outside `allowedScopes`, so approving would widen the row.

The verdict is computed at read time (both at `/authorize` and on
`GET /authorization/oauth-consents/:id`, which returns it as `registration`), never
stored, so two prompts for the same app agree with whatever the row says
now. Nothing is persisted for a `new` client until approval; a denied or
expired prompt leaves no trace of it.

Approving a `new` or `changed` prompt requires the Owner's explicit
`acknowledgedRegistrationChange` (the consent UI's "I recognise this app and this
redirect address" checkbox) — the server rejects the approval without it.
Writing the row, created or widened, takes both `wildflower/Client.c` and
`wildflower/Client.u` of the approver (see [Approval scopes](#approval-scopes)).
On approval the row is created (`kind: 'public'`, every grant type, name
equal to the `client_id`, the one redirect, the granted scopes) or widened:
the exact `redirect_uri` is added to `redirectUris` and the **granted** (not
requested) scopes widen `allowedScopes`, so a later identical request is
`registered` and fast-paths. The clamp on such an approval is
`allowedScopes ∪ requestedScopes`; the approving Owner still cannot delegate
a scope they do not hold themselves.

That widening is by scope, not by string (`wildflowerhealthio_scopes::widened_scopes`):
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

The clients the server defines are exempt — the host app's, the
browser-session client and the FHIR server UI's, marked `server_defined` in
the client's `registrationSource` by boot-time seeding. Their registration is
**fixed** (approvals can't create or widen it), so an unregistered redirect or
scope for one is rejected at the boundary, and approval never widens its
row. Disabled clients are rejected on every endpoint regardless of verdict,
and a widening never clears `disabledAt` — trust the Owner took back stays
taken back until they re-enable the app.

TOFU only ever grows trust, so its other half is the Owner's
[client management](#client) surface: every row TOFU created or widened is
listed in "Trusted Apps", and an app approved by mistake can be disabled
there. There's no per-redirect or per-scope narrowing yet — disabling is
all-or-nothing.

> **Trade-off:** any page can present a _known_ `client_id` with its own
> redirect, and the Owner sees a `changed` prompt under a trusted app's name.
> The prompt's prominent redirect origin and the acknowledgment checkbox are
> the mitigation; the Owner is the trust anchor, as with any TOFU scheme.
> The device flow stays strict.

### AuthorizationRequest

A pending authorization that has been started but not yet resolved: an
OAuth 2.0 request of either grant flow, or a [browser pairing](#browser-pairing)
or [session widening](#session-widening), which are no OAuth grant.

- **Tables:** `code_authorization_requests` (the code flow's),
  `user_code_requests` (device requests and pairings, keyed by a `userCode`
  and claimed by a poll), and `session_widening_requests` (session widenings,
  keyed by id and claimed by a poll).
- **Discriminator:** in `user_code_requests`,
  `flow: 'device_code' | 'browser_pairing'` (`device_code` matches the OAuth
  `grant_type` request parameter). The code table holds one flow and needs none.
- **Status field:** `'awaiting_limited_page' | 'pending' | 'approved' | 'denied'`
  for a code request; `'pending' | 'approved' | 'denied' | 'claimed'` for a
  device request, pairing or session widening.
  Expiry is read from `expiresAt`, never stored as a status;
  `awaiting_limited_page` is a code-flow request waiting on its browser's
  [limited page](#limited-page); `claimed` is an approved device request,
  pairing or session widening whose poll redeemed the approval.
- **TTL:** 5 minutes.
- **Identifier:** `id` (UUID — for code flow, the request id; for
  device flow, the `device_code`; for a pairing, its pairing code; for a
  session widening, its id).
- **Device-flow and pairing extras:** `userCode` (the human-typed RFC 8628
  §6.1 code, formatted `BCDF-GHJK`); `lastPolledAt` (for the `slow_down`
  rate limit); `deviceName` (see [Device name](#device-name); a pairing's
  browser name).

Code-flow rows carry the OAuth client's PKCE `code_challenge`,
`redirect_uri`, requested `scope`, and the `state` parameter. A code-flow row
started by a SMART App Launch also carries the consumed `launch` and the
patient its [LaunchContext](#launchcontext) binds (`launch_bound_patient`).

A code-flow row whose browser session falls short of what it asks for parks
as `awaiting_limited_page` until its browser goes on from the
[limited page](#limited-page), which makes it `pending`, unless that session
went on for the same app before (a row in
`session_shortfall_acknowledgements`) and the request doesn't carry
`prompt=consent`. Only `pending` requests are asked of the Owner.

### LaunchContext

One SMART App Launch `launch` value this server handed out, and what it
binds. An in-process launcher (the apps slice's `POST /apps/{id}`, the base's
Launch) mints it through the authorization server's `LaunchContextMinter` and puts it in the
app's launch URL; the app forwards it to `/oauth/authorize`.

- **Table:** `launch_contexts`, owned by the authorization server. No other slice touches it.
- **Identifier:** `nonce`, the opaque `launch` value (32 CSPRNG bytes,
  base64url).
- **Binds:** the app's `client_id`, or no client (the base's launch: a
  server's launcher can be any app, so the first client to present the value
  takes it), and a nullable `patient`. Only a launch that names its client can
  bind a patient. Nothing sets the patient yet: apps pick it in-app.
- **TTL:** 5 minutes, the same as an `AuthorizationRequest`.
- **Single use:** `/oauth/authorize` consumes it with one conditional `UPDATE`
  (unconsumed, unexpired, minted for the presenting client or for any client),
  so of two racing authorizes only one wins. Expired rows are pruned when the
  next one is minted. A browser without a [browser session](#browser-session)
  is sent to [pairing](#browser-pairing) before the launch is read, so pairing
  never spends it.
- **Refusals:** an unknown, expired, consumed or other client's `launch` is
  `invalid_request`, and the `error_description` says why: a client is told
  its own launch is not recognized, already used, or expired. Another
  client's launch reads exactly like one that doesn't exist, and so does an
  expired launch a later mint has pruned. A request with no `launch` is plain
  OAuth.
- **Patient:** when the context binds a patient, the consent approval must name
  the same patient (`409 LaunchPatientMismatch` otherwise), and a standing
  grant for another patient doesn't take the fast path.

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

The **fast path** is `/oauth/authorize` issuing a code on a standing grant
that covers every requested scope, with no human in the loop. It runs only
for a browser that holds a [browser session](#browser-session): a browser
without one is sent to [pairing](#browser-pairing) first, whatever grant
stands. The code, and the tokens and refresh family it earns, name that
browser's session, so revoking the session ends them, and carry only what
that session also holds of the grant (see
[Browser session](#browser-session)).

- **Table:** `grants`
- **Identifier:** plain string.
- **Indexed by:** `(clientId, redirectUri)` pair, queried via
  `byClientIdAndRedirectUri$`. Re-approval updates via `grantUpdated`
  rather than minting a duplicate row.
- **Scopes union across approvals** (authorization-server-rust): a later approval
  merges its scopes into the standing grant — approving a narrower
  request never un-approves earlier consent. Revoking the grant is the
  way to withdraw consent (and also revokes the client's refresh
  tokens).
- **The union is by scope, not by string** (`wildflowerhealthio_scopes::widened_scopes`):
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
  `lastUsedAt` (when the grant last let a code be issued without
  asking the Owner; for a device grant, when a refresh token it earned
  was last rotated), `patient` (SMART-on-FHIR launch context).

Display name lives on [`Client`](#client)`.name`, not on `Grant`.

### SigningKey

An RSA 2048-bit JWK used to sign and verify authorization-server-issued JWTs.
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
(`/authorization/oauth-consents/*`, `/authorization/devices/*`, `/authorization/grants/*`,
`/authorization/requests/*`). Two-stage check:

1. `internal/jwt.ts:verifyJwt` validates the Bearer token (signature,
   `iss`, `aud`, `exp` — all enforced by `jose.jwtVerify`'s options),
   then looks up the JWT's `sub` in the [`clients`](#client) table.
   Disabled clients are rejected.
2. The middleware then enforces `'owner' ∈ payload.scope`. A
   third-party SMART client's token (with `patient/*.read` scope)
   verifies fine but doesn't pass this gate.

HTML pages in the `authorization-server-pages` group do **not** carry this
middleware; they're public. The middleware reads the access token from the
`Authorization: Bearer` header only. The server accepts two cookies,
`__Host-browser_session` (see [Browser session](#browser-session)) and the
FHIR UI's `hfs_session`, only from its own pages, with an Origin check on
writes, and turns each into a bearer token ahead of the gate
(`wildflower-server-rust`'s `session_cookie_bearer`); with both, `hfs_session`
wins, unless the page asks for the browser session with
`Wildflower-Session: browser` (see [Browser session](#browser-session)). Every
other caller attaches its own bearer: the launcher
its in-memory one.

### Device flow (RFC 8628)

The host app's path to becoming an Owner-authenticated client. Flow:

1. The device POSTs `/oauth/device_authorization` with `client_id`, its
   `scope`, and a `device_name` (see [Device name](#device-name)). Server
   creates a `flow='device_code'` `AuthorizationRequest` and returns
   `{ device_code, user_code, verification_uri, ... }`.
   The verification URIs are the server's own
   [device page](#device-page), at the server's origin:
   `https://<domain>/oauth/device`, and `…/oauth/device?user_code=<code>` for
   `verification_uri_complete`.
2. Owner confirms the `user_code` on the device page (typed, or filled in by
   `verification_uri_complete`) in a browser signed in as the Owner (see
   [Same-device sign-in](#same-device-sign-in)). The
   host app opens the device page with the code filled in for the newest of
   the [pending consents](#pending-consents).
3. Owner reviews the request (device name + requested scopes) and approves via
   `POST /authorization/devices/:userCode/approve`, which takes
   `wildflower/Grant.c` of the approver (see
   [Approval scopes](#approval-scopes)). The Owner may add scopes beyond
   what the device requested (up to the client's `allowedScopes`) or prune them
   — see [Expandable consent](#expandable-consent) — and, from the settings
   surface, adjust the device name.
4. Browser polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
   until status flips. Returns `authorization_pending` while waiting,
   `slow_down` if polled faster than the advertised `interval` (5s),
   `access_denied` / `expired_token` on terminal failure.

The device_code is single-use: the row's status flips to `claimed` on
the first successful token mint so a second poll returns `expired_token`.

### Device name

A human-chosen label for the device being paired ("Ada's laptop"), distinct from
the OAuth [client](#client) name (every device paired as one client shares
that client's name, so the client name can't tell them apart). A
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

### Pending consents

The authorization requests waiting on the Owner, spanning **both** grant flows,
browser pairings and session widenings: a device-code request parked by
`/oauth/device_authorization`, an authorization-code request parked by
`/oauth/authorize`, a [browser pairing](#browser-pairing) started at
`/oauth/pair`, and a [session widening](#session-widening) asked from the
limited page, alike. The host asks
about one at a time, the newest by `requestedAt`, like a stack: a new request
takes over from the one before it, and deciding it brings back the newest of
those still pending.

Starting a request is rate-limited on the tunnel, per visitor address and
overall, and a request over either limit is `429` (the host's
`authorization_start_limit`). A browser whose session can decide consents,
as one signed in as the Owner can, is limited only when its request is raised
for the Owner (every device request is) or parks for the
[limited page](#limited-page), so one it decides on its own consent card is
never limited. A request parked for the limited page has spent from the limit
whichever browser made it, so going on from there asks nothing. Nor is a
browser without a session at
`/oauth/authorize`, which is only sent to [pairing](#browser-pairing) and
parks nothing. Asking to widen a session from the limited page spends from
it too, as a request raised for the Owner does.

The newest is an `OwnerPrompt`, discriminated because the flows have
no shared lookup key, with the name of what asks: the client's (its registered
name, or its `client_id` while it has none), or a pairing or widening
browser's:

| Flow               | Newest pending consent                       | Decided at                                                   |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| Device (RFC 8628)  | `{ kind: 'device', userCode, clientName }`   | the device page, `/oauth/device?user_code=`                  |
| Authorization code | `{ kind: 'oauth', id, clientName }`          | the consent card, `/oauth/authorize/{id}/consent`            |
| Browser pairing    | `{ kind: 'browser', userCode, browserName }` | the device page, `/oauth/device?user_code=`                  |
| Session widening   | `{ kind: 'widening', id, browserName }`      | the widening's card, `/oauth/session-widenings/{id}/consent` |

The Rust side recomputes it (`owner_prompt`) after every transition
that could change it — either flow's insert, approve, or deny — and publishes
it on a `watch` channel. The Tauri host carries each server's newest pending
consent in the server's status, posts a notification ("‹client› wants access
to ‹domain›"; for a pairing "‹browser›, a remote browser, wants to sign in
to ‹domain›"; for a widening "‹browser›, a remote browser, wants more access
to ‹domain›") once for each request it hasn't notified for, and on the
desktop, where a notification can't be clicked, opens the request at once. A
request that comes back once a newer one is decided doesn't notify again. A
code request made by a browser whose session can decide it (holding its
[approval scopes](#approval-scopes)), as the Owner's can, neither notifies nor
opens: `/oauth/authorize` sent that browser
to the consent card, and records on the request that it can be decided there
(`decidable_in_requesting_browser`, carried on the newest pending consent).
Once that browser asks the server's owner from the card, the request is
raised (`POST /authorization/oauth-consents/{id}/ask-owner`, gated like the
read on `wildflower/AuthorizationRequest.r`, clears the flag and republishes)
and notifies once, as a new request does. Raising one spends from the
authorization start limit, as a start the Owner is asked about does (`429`
when refused, the request left as it was); asking about a request already
raised spends nothing.
The base's server page shows it as a pending request; Open, a tap on the
notification on a phone, or the notification itself on the desktop opens its
page in a browser signed in as the Owner, with `then=back` (see
`apps/host/servers`'s
[Server Runs Explanation](../../../apps/host/servers/docs/Server%20Runs%20Explanation.md)).

A code request waiting on its browser's [limited page](#limited-page) isn't
pending for the Owner until that browser goes on: the newest pending consent
skips it, and the consent read, approve, deny and ask-owner answer `404` for
it.

A request that the [grant](#grant) fast path fully pre-approves is never pending:
`/oauth/authorize` approves it in the same handler, so it never sits
`pending` awaiting a human. Requests are dropped once expired — a background
reaper re-runs the query so an idle host doesn't stay stuck on a request whose
TTL lapsed.

The host also watches one request it opened, through the
`PendingConsentWatcher` the authorization server hands it: it rereads that
request, by its `ConsentKey` (the device request's or pairing's `user_code`,
or the code request's or widening's `id`), each time the newest is recomputed, changed or not, so it
sees the request decided or expired even while a newer one stays newest. On
iOS the host closes the page it opened the request at once it settles.

Leaving the consent page undecided decides nothing: the request stays pending
and answerable from the server's page in the host until it expires, while the
requesting browser keeps waiting (on the [wait page](#wait-page) for a code
request).

### Wait page

The page `/oauth/authorize` parks a browser on while the Owner decides, when
its [browser session](#browser-session) can't approve the request itself:
`/oauth/authorize/{id}/wait`, served by the authorization server itself at the
server's origin, `https://<domain>`. The `Location` is relative to
`/oauth/authorize`, so no launcher address is involved. The page is static
HTML, CSS and JS (`authorization-server-rust/src/http/routes/oauth/wait_page/`). It polls
`GET /oauth/authorize/{id}` (the **status poll**), which reads the browser
session the browser's cookie holds (the cookie rides the same-origin poll).
It answers the session the request was made in, and a session whose grant
covers `wildflower/AuthorizationRequest.r` and `wildflower/AuthorizationRequest.u`,
the scopes that load and decide the request on the
[consent card](#consent-card), as the Owner's does once the Owner signs in at
`/oauth/sign-in` in this browser and the new session's cookie replaces the old
one. Such a session could approve the request itself, and the code is bound by
PKCE to the app that asked, so the read gives it nothing new. Any other
caller, with another session or none, gets the same `404` as an unknown id, so
a leaked request id can't collect the code. Once the request is decided, the
page leaves for the
redirect the status carries, which the authorization server built from the client's
allowlisted or just-approved `redirect_uri`. That makes this redirect the only
address a sign-in ever leaves the authorization server for, and no request parameter can
name a different one. The page takes no decision itself: the Owner answers on
the [consent card](#consent-card), in this browser once it can decide the
request, or in one the host opens. While the request is pending, the page
also reads `GET /authorization/oauth-consents/{id}` on the browser's browser
session, asked for with `Wildflower-Session: browser`; once that succeeds
(the browser has signed in as the Owner since), it switches to the consent
card beside it.

It interpolates nothing (the script reads the request id from its own path),
loads only from its own origin under a strict CSP, and follows only an
`http:`/`https:` redirect. Its colours are copies of `react-tundraish` palette
tokens under the same names.

### Limited page

The page `/oauth/authorize` sends a browser to when its
[browser session](#browser-session) holds less than the request asks for:
`/oauth/authorize/{id}/limited`, on the server's own origin, from the same
**authorization pages** bundle and with the same headers as the
[consent card](#consent-card). The request's **session shortfall** is what
a code issued in that session would not carry of the requested scopes, by the
rule that bounds every code (see [Browser session](#browser-session)): each
requested scope the session holds none of, as the request spells it, and of
each it narrows, the part the session lacks. A session holding
`system/*.cuds` and `system/Patient.r` lacks `system/MedicationRequest.r` of
`system/MedicationRequest.rs`, and nothing of `system/Patient.rs`.
`/oauth/authorize` works it out once the request is validated and its launch
consumed, before the [fast path](#grant), the start limit and the Owner.
When it isn't empty, it parks the request as `awaiting_limited_page` and sends the browser here,
unless that browser session has pressed Continue for the same app before and
the request doesn't carry `prompt=consent`. What the session holds is read
from its `browser_sessions` row, which a [session widening](#session-widening)
grows, not from its token. A same-device session, holding `OWNER_SCOPES`,
falls short of nothing and never sees the page.

The page reads `GET /oauth/authorize/{id}/session-shortfall` (the app's name
and the scopes the session lacks) and says, for example, "This browser isn't
allowed to read and search Observations, which Strength expects. Strength may
not be able to do everything." The scopes are in the words the scope picker
uses (`scopes-react`'s `fluentScope`), and the message sits above three buttons:

- **Continue** posts `/oauth/authorize/{id}/continue`, which makes the
  request `pending`, gives it a fresh five minutes, and takes the branch the
  start would have taken. A standing grant
  that still covers the request issues a code, narrowed to the session.
  Otherwise the request is raised for the Owner, and the browser goes to the
  consent card or the [wait page](#wait-page), as recorded at the start.
  It spends nothing from the authorization start limit: the request spent
  from it when it parked. An app disabled since the request parked ends it
  instead: the request is denied, and the browser goes back to the app with
  `access_denied`.
- **Cancel** posts `/oauth/authorize/{id}/cancel`, which denies the request,
  and the browser goes back to the app with `access_denied`.
- **Ask the server's owner** posts `/oauth/authorize/{id}/ask-to-widen`, which
  files a [session widening](#session-widening) for exactly what the session
  lacks of the request and keeps the request waiting here as long as the
  widening waits for the Owner. The page polls the widening and says above the
  buttons that it is waiting, that the Owner declined, or that the Owner
  didn't answer in time. Once the Owner widens the session, the page reads
  what the session still lacks, and goes on at once when that's nothing.

Continue also remembers the (browser session, app) pair, one row in
`session_shortfall_acknowledgements` keyed by `sid` and `client_id`. A later
request from that session for that app skips the page and goes on as if
acknowledged, whatever the session then lacks of it; another session, or the
same session for another app, still stops here, as does a request carrying
`prompt=consent`. The launcher is an app like any other: a browser paired
with less than it asks for sees the page on its first sign-in and not again
for that session, until its Request access signs in with `prompt=consent`.
An approved session widening forgets every pair of its session, so its next
sign-ins carry the wider session or stop here for what it still lacks. Cancel
remembers nothing. The
rows end with their session: the retention sweep deletes them when it
deletes the session.

Both answer `{ location }`, where the page sends the browser, which it follows
only for `http:`/`https:`. Until Continue the request is the browser's alone:
it isn't a [pending consent](#pending-consents) and no code is issued for it.
The page's calls answer only the browser session the request was made in, read
from its cookie as the status poll reads it; any other browser, with another
session or none, gets the `404` an unknown id gets. So does a request no
longer waiting there (continued, cancelled, decided, or past its five
minutes), and the page then goes to the wait page, which says how it ended.

### Session widening

A paired browser asking the Owner, from the [limited page](#limited-page), for
its own [browser session](#browser-session) to hold more, rather than pairing
again, which would end the session and everything minted under it. One row in
`session_widening_requests`, keyed by id, naming the session (`sid`), the app
whose request the session fell short of, the session's name, and the scopes it
lacked of that request: the most the Owner may grant. It waits five minutes,
as the request on the page does.

The Owner decides it on its own card, `/oauth/session-widenings/{id}/consent`,
an authorization page reading `GET /authorization/session-widenings/{id}` and
posting `…/approve` or `…/deny` (gated like the device page, on
`wildflower/AuthorizationRequest.r` to read and `.u` to decide). The card's
ticks start from what was asked that the approver may pass on, and the Owner
may only untick: an approval is clamped to what was asked and to the
approver's own grant, and records no grant. Approving grows the session's
`scopes` by what was granted, never shrinking them, with the same `sid` and
expiry, and forgets every client the session went on past the limited page
for. A decline leaves the session as it was. A widening whose session has
ended since is denied.

The limited page's poll, `POST /oauth/session-widenings/{id}/poll`, answers
only the session the widening is for. The first poll after an approval claims
it, once: it sets the session's new token, for the same session and with what
it holds now, as the browser's cookie, and revokes the token it replaces.

### Consent card

The page a browser signed in as the Owner decides a parked
authorization-code request on: `/oauth/authorize/{id}/consent`, on the
server's own origin, so the address bar names the server being approved.
`/oauth/authorize` sends a browser there instead of the
[wait page](#wait-page) when the request carries a live
`__Host-browser_session` cookie, and the wait page switches to it once
the browser signs in.

It is a React page from the **authorization pages** bundle
(`apps/host/wildflower-server/authorization-server-web`), which the
authorization server embeds and serves with the wait page's headers; its
hashed scripts, stylesheets and fonts are at `/oauth/assets/*`, cached as
immutable.
It has no API of its own. On the browser session, which the host's
cookie→bearer layer presents as the bearer, and which every request asks for
with `Wildflower-Session: browser` (so a browser also signed in to the
FHIR web UI still acts as the Owner), it reads
`GET /authorization/oauth-consents/{id}`, searches FHIR `GET /Patient?name=…`
when the request asks for a patient, and posts `/approve` or `/deny`. The card
is `authorization-react`'s `OAuthConsentCard`: the app's identity and where it
sends the browser back to, the [trust-on-first-use](#trust-on-first-use)
warning and its acknowledgement, the requested scopes (unticking only), the
patient search, and Approve and Deny. The decision's answer carries the
client's callback (`code` + `state`, or `error=access_denied` + `state`), and
the page leaves for it with `location.replace`, only for an `http:`/`https:`
URL. A browser that can't read the request (`401`, `403`, or `404` once it is
no longer pending) goes to the wait page instead. A browser whose session
lacks some of the request's [approval scopes](#approval-scopes) (the read's
`missingApprovalScopes`) sees "This browser can't allow this app." above the
buttons, none of the patient search, registration warning or scopes, and "Ask
the server's owner" in place of Allow, with no Deny either when what it lacks
includes `wildflower/AuthorizationRequest.u`. Asking posts
`/authorization/oauth-consents/{id}/ask-owner`, which raises the request for
the Owner so the host notifies them, then goes to the wait page; if the post
fails, the page says to approve on the device running the server.
The FHIR server doesn't yet limit a `patient/` scope to the token's patient
(it checks it like a `system/` one, #416), so while the draft grants any
`patient/` scope the card warns, above Allow and Deny, that the app can read
those records for every patient.

The host app opens the card as `/oauth/authorize/{id}/consent?then=back` in a
browser signed in as the Owner (the desktop's default browser, an in-app
browser on mobile) to decide a request another browser made. In that mode the
card leaves for no callback: the other browser's wait page sees the decision
and finishes the flow. After Allow or Deny it says how it went ("Approved. You
can close this." or "Declined. You can close this.") and goes back in the
browser's history, or closes the window when there is no history to go back
to, and its Close button does the same again for a browser that kept the page
open. On iOS the host closes the in-app browser's view itself once the request
settles.

### Device page

The RFC 8628 verification page: `/oauth/device` (`verification_uri`) and
`/oauth/device?user_code=…` (`verification_uri_complete`), on the server's own
origin, from the same **authorization pages** bundle and with the same headers
as the [consent card](#consent-card). It has a code box, filled in from
`user_code` when the URL carries one but sent only when the Owner presses
Continue (RFC 8628 §5.4), so a phished link can't approve a code on its own.
On the [browser session](#browser-session) it reads
`GET /authorization/devices/{userCode}` and shows `authorization-react`'s
`DeviceConsentCard`, which posts `/approve` or `/deny`; then it tells the Owner
they can return to the device. It decides a [browser pairing](#browser-pairing)
the same way: the card then says "A browser wants to sign in to your server",
names the browser and marks it **Remote**, and shows no application; once
approved, the page says the browser signs in on its own. Opened by the host
app as `/oauth/device?user_code=…&then=back`, it instead says how it went and goes
back, or closes the window, with a Close button that does it again, as the
consent card does. It follows the API's answers rather than
checking who is signed in. On load it reads `GET /authorization/session`: with
no session, or one whose scopes don't cover `wildflower/AuthorizationRequest.r`
and `.u`, it says to approve the request on the device running the server (its
notification, or the server's page in the Wildflower app), with no sign-in link,
shows no code box and leaves the request pending; a `401` or `403` on a code's
read later does the same. A `404` means no device is waiting with that code,
and the Owner can enter another.

### Wildflower host app

The app on the Owner's device that runs this server in its own process. Its
OAuth client is `WILDFLOWER_HOST_APP_CLIENT_ID`, allowed only `openid`. It
holds no token of its own: it decides
consents, mints launches and mints same-device sign-in codes in-process, as
the Owner.

### Same-device sign-in

How the [Wildflower host app](#wildflower-host-app) signs a browser on its
own device in as the Owner: with a one-time **same-device sign-in code**.
Wildflower has no accounts or passwords; the Owner is whoever holds the device
running the server, and the host app runs on that device.

1. The host app mints a same-device sign-in code in-process, through the
   `SameDeviceSignInCodeMinter` its `WildflowerServer` hands out (no HTTP
   call). A code is 256 random bits, single use, and valid for 60 seconds. The
   server keeps only its hash, in memory, so a restart drops it.
2. The host app opens `https://<domain>/oauth/sign-in?code=…&next=…` in a
   browser: for each launch, `next` is the launch URL; for the server
   card's Authorization, the server's Authorization app with `iss`; and for
   a pending request, its consent card or the device page, with `then=back`.
3. The server redeems the code (`RedeemedSameDeviceSignInCode`, an authority
   proof), stores the `same_device` [browser session](#browser-session) it starts,
   and mints a token through the ordinary minter, issued to the
   browser-session client (its `sub`) and holding the Owner's
   grant (`OWNER_SCOPES`, the grant the Owner decides consents with), as a
   JWT with its own `jti` and the session's [`sid`](#sid-session-id) that
   expires in 8 hours, with the session.
4. It answers `303` to `next`, setting
   `__Host-browser_session=<the token>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`.

`next` must be a path on the server (starting with `/`, not `//`), a URL under
the hosted launcher or the Wildflower Authorization app, or a URL under the
launcher or Authorization app the host opens for this server, from the
server's record (the page itself, whatever its query, or a URL within it as a
folder). Any other
`next`, an unknown, spent or expired code, or a disabled
browser-session client, gets a local error page with no cookie and
no redirect; a refused `next` or a disabled client leaves the code unspent.
Enabling the client again lets sign-in work. Disabling it signs no browser
out: a browser already signed in keeps its session until the token expires or
is revoked.

### Browser pairing

How a browser that isn't the Owner's gets a [browser session](#browser-session):
it shows a code, and the Owner approves it. Pairing is its own request kind,
not the OAuth device grant: the browser-session client may use no grant type,
so `/oauth/token` never mints a browser's token, and pairing writes no grant
and no refresh family. The session row is its only record.

1. A browser opens `https://<domain>/oauth/pair?next=…`, the **pairing page**,
   from the same **authorization pages** bundle and with the same headers as
   the [consent card](#consent-card). `next` must be a path on the server
   (starting with `/`, not `//`). `/oauth/authorize` sends a browser without
   a session here with a `302` to `pair?next=<its own path and query>` (the
   **pairing redirect**), parking, notifying and consuming nothing, so the
   paired browser comes back to the same request. A SMART app's `launch`
   lives 5 minutes; one that lapsed while the Owner approved the pairing goes
   back to the app told it expired (see [LaunchContext](#launchcontext)).
2. The page posts `/oauth/pair/start`. The server parks a `browser_pairing`
   [`AuthorizationRequest`](#authorizationrequest) for the browser-session
   client, keyed by a 256-bit **pairing code**, with a `userCode` and a name
   taken from the browser's `User-Agent` (`"Firefox on Linux"`, or `Browser`).
   It answers the pairing code, the `userCode`, the name, and `next`, resolved.
   Only that page holds the pairing code.
3. The page shows the code and a name field, and polls `/oauth/pair/poll`
   with the pairing code and the name as it stands every `interval` (5s),
   waiting longer after a `slow_down`. While the request is pending each poll
   records the name. The host notifies the Owner of the newest pending
   consent, as for any request.
4. The Owner decides it at the [device page](#device-page). The request asks
   for `OWNER_SCOPES`, so the Owner's card opens with all of them ticked, and
   the Owner unticks what the browser shouldn't have; no tick goes past
   `OWNER_SCOPES` ([Expandable consent](#expandable-consent)). An approval
   delegates nothing the approver doesn't hold, neither a resource scope nor
   `wildflower/launch`, so an approver holding less opens the card with
   everything it may delegate ticked instead
   (`ApprovableScopes::delegable_scopes`, the card's `startingScopes`). What
   the session holds bounds every code a request made in it earns.
5. The first poll after the approval claims the request
   (`ClaimedBrowserPairing`, an authority proof), stores the `paired` browser
   session it starts, named as approved, holding exactly the approved scopes
   and lasting 24 hours (`PAIRED_SESSION_TTL`), and mints the session's token
   for the browser-session client, for 24 hours. It answers `approved`,
   setting `__Host-browser_session=<the token>; …; Max-Age=86400`, and the page
   goes on to `next`. Later polls find the request claimed and answer
   `expired`.

The request expires 5 minutes after it starts, like any authorization request.
Starting one is not rate-limited. The poll's JSON body needs a preflight from
any other origin, and CORS never allows credentials, so only the server's own
pages can have its cookie set.

### Browser session

A browser the server has signed in, one row in `browser_sessions`, keyed by
its `sid`. Its `kind` says how the browser came to hold it: `same_device` for a
browser signed in as the Owner with a
[same-device sign-in](#same-device-sign-in), `paired` for any other browser,
signed in by a [browser pairing](#browser-pairing). A same-device session has no
`name`, holds `OWNER_SCOPES`, and expires 8 hours (`SAME_DEVICE_SESSION_TTL`) after
the sign-in. A paired session has the name the browser was approved under,
holds the scopes the Owner granted, and expires 24 hours
(`PAIRED_SESSION_TTL`) after the pairing.

The browser holds its session in the `__Host-browser_session` cookie, whose
value is the session's token, issued to the browser-session client (its
`sub`), so a restart doesn't sign the browser out. One browser is signed out
by revoking its browser session or its token's `jti`; every browser is signed
out by revoking the browser-session client's subject. A request whose cookie
holds an expired or revoked token is served as if the cookie weren't sent, and
the response clears it. The cookie needs `https`, as the server's origin,
`https://<domain>`, is. A session belongs to the cookie store it was set in:
an iOS in-app browser (`SFSafariViewController`) keeps its own, separate from
Safari's, so a browser paired in Safari pairs again in an app's in-app browser
(see `tauri-plugin-native-page-browser`'s
[Explanation](../../../apps/host/tauri-plugin-native-page-browser/docs/Explanation.md)). `/oauth/authorize` reads the cookie before anything
else: a browser without a live session is sent to
[pairing](#browser-pairing), and nothing is issued to it, the
[fast path](#grant) included; that spends nothing from the authorization start
limit. A parked request from a browser whose session can decide consents (its
scopes cover both `wildflower/AuthorizationRequest.r` and
`wildflower/AuthorizationRequest.u`, as `OWNER_SCOPES` do) and that holds the
request's [approval scopes](#approval-scopes) goes to the
[consent card](#consent-card) rather than the [wait page](#wait-page), and
records that it can be decided there (`decidable_in_requesting_browser`). One
whose session lacks any of them goes to the wait page, and the request is
raised for the Owner like any other; so is every request from a session that
can't decide consents. A session that can decide consents spends from the
authorization start limit only when its start is raised for the Owner (every
device start is), so a request it decides on its own card spends nothing, and
it can't flood the Owner with notifications either: asking the Owner about
such a request afterwards (`…/ask-owner`) spends then. Any other session's
start spends before it is parsed.
Only a token issued to the browser-session client under a browser session
(its `sid`) counts: any other token in the cookie is served as no session.

A browser can hold the FHIR web UI's `hfs_session` beside this cookie. A
request carrying both gets `hfs_session`'s bearer, so the UI runs as its own
signed-in user, unless it carries the header `Wildflower-Session: browser`:
then it gets the browser session's bearer, or none if this cookie is missing
or its session has ended, never `hfs_session`'s. Any other value is read as no
header. The consent card, the device page and the wait page's check for the
card send the header. It needs no guard of its own: it isn't CORS-safelisted,
so another origin's page sends it only after a preflight, and since CORS never
allows credentials, that request carries neither cookie.

Everything minted under a session names it as its [`sid`](#sid-session-id):
the browser's own token, and an authorization request made in that browser,
the code it earns, and that code's access tokens and refresh family. Every
authorization-code request is made in a session, so its code and family
always name one: the session of the browser that made the request, not of
whichever browser approved it, so revoking the browser the app runs in is
what ends it.

**Revoking** a session sets its `revoked_at` and ends all of them: the token
verifier refuses a token whose `sid` names a revoked session, on the
`/authorization` gates and the FHIR server alike, and refresh redemption
refuses a family whose `sid` does. A request still pending when its session
is revoked, or expires, is denied when it is approved, so the app gets
`access_denied` rather than a code. A `sid` that names no row is treated as revoked. Whether a session's _expiry_ ends a refresh family is the client's
refresh policy; today it doesn't. Tokens, requests and families with no
`sid` (the host app's in-process tokens, the device flow) have no session to
check.

A code carries only what both its approval and the session of the browser
that made its request allow: the approval's scopes (the Owner's ticks, or the
standing grant's coverage on the [fast path](#grant)), each resource scope
narrowed to the part the session holds, and `wildflower/launch` only if the
session holds it. A resource scope the session covers stays as approved;
coverage is the rule an approver is held to: either SMART spelling, `system/*`
covering `patient/*` and `user/*`, and the session's scopes taken together, so
`system/*.cuds` and `system/Patient.r` cover `system/Patient.rs`. One the
session covers only in part narrows to its intersection with each session
scope, so an approved `system/*.cruds` in a session holding
`system/Patient.cruds` gives the code `system/Patient.cruds`, and an approved
`patient/Observation.rs` in a session holding `patient/Observation.r` gives it
`patient/Observation.r`. One the session holds none of is dropped. Identity
and session markers (`openid`, `fhirUser`, `launch`, `launch/patient`,
`offline_access`) pass through. The request and the standing grant record the
approval as made; the code's tokens and refresh family take the code's scopes.
So a browser paired without `patient/Observation.rs` earns no app a code for
it, whoever approves, and a same-device session, holding `OWNER_SCOPES`,
bounds nothing. A browser whose session falls short of a request is told so before
anything is issued or asked, on the [limited page](#limited-page), where it can
ask the Owner to widen the session ([session widening](#session-widening)). Launching
an app from Home needs only `wildflower/launch`: what the app may then do is
bounded here, at its own `/oauth/authorize`.

**Last seen** (`last_seen_at`) is when the session was last in use. Signing in,
or pairing, sets it, and two uses move it: the host's cookie→bearer layer accepting the
session's cookie, at most once every five minutes per session
(`LAST_SEEN_RESOLUTION`; an in-memory per-`sid` throttle sits in front of a
conditional update, so most requests write nothing), and a refresh
family that names the session rotating, so a browser whose apps only refresh
still shows as in use. An access token presented to the FHIR server doesn't
move it.

The Owner lists the live sessions, neither revoked nor expired, with
`GET /authorization/browser-sessions` (`wildflower/BrowserSession.r`), each
marked `heldByCaller` when the caller's token names it as its `sid`, and
revokes one with `DELETE /authorization/browser-sessions/{sid}`
(`wildflower/BrowserSession.d`); Wildflower Authorization's Browsers section
shows the first as "This browser", and revoking it signs that browser out. A
browser signs itself out with `POST /oauth/sign-out`, the **Sign out** button
in the footer of the server's own pages, under "Signed in until" the session's
expiry, which `GET /authorization/session` answers as
`browserSessionExpiresAt`. Sign-out is authenticated by the cookie alone, and
the host's cookie→bearer layer refuses it from any origin but the server's.
It revokes the session, clears the cookie and sends the browser `303` to the
launcher's root; a browser with no standing session is sent there too, its
cookie cleared.

The retention sweep deletes a session 24 hours after it expired or was
revoked, unless a refresh family alive by then still names it, and the apps it
went on past the [limited page](#limited-page) for with it.

A session's scopes grow only by a [session widening](#session-widening) the
Owner approved; its `sid` and expiry never change.

- **Table:** `browser_sessions`
- **Identifier:** `sid` (a random UUID).
- **Kind:** `'same_device' | 'paired'`.

### Expandable consent

The device-code consent path is **expandable**: the Owner may grant scopes the
device did **not** request, up to the client's `allowedScopes`, as well as narrow
what was asked. This contrasts with the **clamped** authorization-code / app
consent path, where the grant may only be narrowed within the requested set
(`granted ⊆ requested`) — a third-party app can never widen its own grant. The
distinction lives in the `ApprovableScopes` constructors: `for_device`
measures the grantable subset against `client.allowedScopes`; `for_code`
measures it against the request's `requestedScopes`; `for_browser_pairing`,
also expandable, against `OWNER_SCOPES`, so no paired browser session holds
more than a same-device session. The shared scope-picker UI models the
same split with its `expandable` vs `clamped` mode.

### Scope sets

A consent decision reads several scope lists at once, so the Rust names each
one by **where it comes from**:

| Name                            | Source                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `requested_scopes`              | The OAuth client's request (`?scope=`, or the device request).                                               |
| `owner_approved_scopes`         | The scopes the Owner ticked on the consent prompt (`approvedScopes` on the wire).                            |
| `registered_client_scopes`      | The client's stored registration (`Client.allowed_scopes`, `allowedScopes` on the wire).                     |
| `registration_ceiling_scopes`   | The most a code approval may grant: the registration, plus the request for a client trusted on first use.    |
| `unregistered_requested_scopes` | Requested scopes the registration does not cover (`newScopes` on the wire).                                  |
| `approver_missing_scopes`       | Resource scopes an approval would grant that the approving Owner does not hold (`missingScopes` on the 403). |
| `missing_approval_scopes`       | [Approval scopes](#approval-scopes) the reader of a consent prompt does not hold (`missingApprovalScopes`).  |
| `granted_scopes`                | What an approval delegated, recorded on the request; on the code and refresh family, bounded by the session. |
| `OWNER_SCOPES`                  | The Owner's authority: `WILDFLOWER_WIDEST_SCOPES` plus `wildflower/launch`, defined in code.                 |

An approval with any `approver_missing_scopes` is refused as a whole with
`403 InsufficientScope`. Nothing is recorded, no code is issued, and the request
stays `pending`, so an approver whose token does cover it can still answer it.
A code approval's requested resource scopes are among its
[approval scopes](#approval-scopes), so it is refused before the ticks are
looked at; on the device page, whose consent is expandable, the approver
picks within what it holds and a tick beyond that is refused.

### Approval scopes

An approver may approve a request only when it can decide it and create what
approving it creates. Approving takes:

| Approving                                                                           | Scopes                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Any request: decides it                                                             | `wildflower/AuthorizationRequest.u`             |
| A code or device request: records the standing [grant](#grant)                      | `wildflower/Grant.c`                            |
| A code request from a client [trusted on first use](#trust-on-first-use): writes it | `wildflower/Client.c` and `wildflower/Client.u` |
| A code request: grants what it asks for                                             | each resource scope it asks for                 |

The client scopes come as a pair, whatever the registration verdict says:
an approval creates the row when it is missing and widens it otherwise,
deciding which from the row as it reads it inside the write, so what an
approver must hold never turns on a row a sibling approval just changed. The
server-defined clients have fixed registrations, so approving their requests
takes no client scope, and of the resource scopes only those the registration
allows. A code approval takes the requested resource scopes because the card
offers its approver no narrowing it can't make: a browser that can't approve
the request as asked asks the Owner instead. A [browser pairing](#browser-pairing)
records no grant and registers no client, so it takes
`wildflower/AuthorizationRequest.u` alone; device consent is expandable, so a
device request's approver picks within what it holds (see
[Scope sets](#scope-sets)). `OWNER_SCOPES` cover every approval scope, so a
same-device session can always approve; a [paired browser](#browser-session)
can only with the scopes its pairing granted.

`ApprovableScopes::missing_approval_scopes` (in `domain/authority`) is the one
rule. `DelegatedScopes::clamp`, the proof every approval's writes take,
checks it before anything else, so an approver lacking one is refused as a
whole with `403 InsufficientScope` naming the missing scopes, nothing is
written, and the request stays `pending` for the Owner. The proof also says
whether the approval writes the client registration, which is all the grant
writer goes by. `GET /authorization/oauth-consents/{id}` and
`GET /authorization/devices/{userCode}` return the ones the reader lacks as
`missingApprovalScopes`; the [consent card](#consent-card) asks the server's
Owner in place of Allow when there are any, and the device page sends the
Owner to the device running the server. `/oauth/authorize` sends a browser to
the consent card only when its session lacks none.

### `authorization-server-pages` group

The HttpApi group whose endpoints serve **HTML** to humans
(`OAuthConsentPage`, `DeviceEntryPage`, `DeviceConsentPage`). Core ships definitions only; consumer slices
(`authorization-react`) provide the handler layer through the phantom-id
bridge described in `docs/Effect/HttpApi Composition How-To.md`. Every
page is public; auth is JS-driven on the JSON endpoints behind them.

### `access-management`

The HttpApi group fronting the **Owner-facing** JSON endpoints under
`/authorization/...` — list/inspect/revoke `Grant`s, list/update
[`Client`](#client)s, list/decide pending HTTP requests. These all go through `RequireAuthMiddleware`.

### HTTP request gating (`httpRequests` table + `/authorization/requests`)

A separate, authorization-server-as-proxy concern: inbound HTTP requests are logged
to `httpRequests` and pause until the Owner approves or denies them.
**Not currently wired** — the `/authorization/requests` endpoints are defined
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
(the server-defined clients excepted), and until the Owner approves, the URI is
untrusted — no error redirects to it.

### `scope`

Space-delimited list of permission strings the OAuth client is asking
for. Compared against `client.allowedScopes`; a scope outside that set makes
the request a `changed` [registration verdict](#trust-on-first-use) that the
Owner is warned about (the server-defined clients excepted — their requests
are rejected with `invalid_scope`). Stored on
`AuthorizationRequest.requestedScopes`,
`AuthorizationCode.grantedScopes`, and `Grant.scopes`.

### `state`

Opaque CSRF token chosen by the OAuth client. Echoed verbatim in the
final redirect. Not used by the authorization server logic; persisted in the
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
- **`code_challenge_method`** — `S256` is the only value accepted, so it
  isn't stored. RFC 7636 also defines `plain` but we reject it.
- **Verification** — `internal/pkce.ts:computeCodeChallenge` recomputes
  the challenge from the verifier at token exchange and compares with
  `timingSafeEqual`.

### `iss` (issuer) and `aud` (audience)

JWT claims (RFC 7519 §4.1.1, §4.1.3) — _who_ minted this token and _for
whom_ it's intended. Both are the server's origin, `https://<domain>` (no
path suffix), on every token the authorization server mints — OAuth and host owner alike. See
[Origins Explanation](../../../docs/Origins/Explanation.md).

A loose intuition: **`iss` is "who I am, the signer"; `aud` is "who I'm
talking to, the verifier."** A token signed for `aud=A` should not be
honored by `aud=B`, even if the signature is valid.

The `TokenVerifier` accepts only the server's origin, as `iss` and as `aud`;
every request is served at that origin. Both checks are performed by
`verify_access_token`'s `AccessTokenVerifyOptions` (`expected_issuer`,
`accepted_audiences`) — not by manual post-verify checks — so a caller using
`verify_access_token` directly is forced to pass them and can't silently accept
any iss/aud.

### `sub` (subject)

JWT claim — _whom_ the token is about. Required to be a string; required
to resolve to a registered, enabled [`Client`](#client) row. The
[`clients`](#client) lookup is the authoritative gate that distinguishes
"valid token issued by this authorization server" from "valid signature but
not-our-issuer".

### `sid` (session id)

JWT claim naming the [browser session](#browser-session) the token was minted
under (the OpenID Connect spelling). Absent when there was none, as for the
device flow. Every authorization code records it, as does the refresh family
the code starts, so a token minted from either names the same session. A token whose `sid` names a revoked session is refused.

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

A browser without a [browser session](#browser-session) is sent to
[pairing](#browser-pairing) first and comes back once the Owner approves it.
A browser whose session holds less than the request asks for stops at the
[limited page](#limited-page) and goes on only if it presses Continue.
Unless an existing [grant](#grant) pre-approves every requested scope, the
request is then parked for the Owner: it joins the
[pending consents](#pending-consents), so the host app notifies
it and its server's page offers it. A browser whose session can approve the
request lands on the [consent card](#consent-card) and decides there; any
other lands on the [wait page](#wait-page), which redirects the client once
its poll observes the outcome, whichever surface decides it. A browser paired
for launching apps (`wildflower/launch`) can't approve, so it waits rather
than decides.

### Device authorization flow / `grant_type=urn:ietf:params:oauth:grant-type:device_code`

RFC 8628. The grant type a no-redirect-capable OAuth client uses to
bootstrap onto a deployment. See
the [Device flow](#device-flow-rfc-8628) section above.

### Refresh token / `grant_type=refresh_token`

RFC 6749 §6, implemented in authorization-server-rust with OAuth 2.1 rotation
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
- **Revocation:** soft — killing a family (replay detection,
  `DELETE /authorization/grants/{id}` revoking the client's standing consent,
  or the client revoking one of the family's tokens at `POST /oauth/revoke`)
  pulls the family's `expires_at` back to the revocation instant and
  stamps its live token consumed. Rows are never deleted, so the lineage
  stays auditable.
- **Client epoch:** redemption refuses a family that began before its
  client's [revocation epoch](#access-token-revocation-jti-denylist--subject-epoch),
  so bumping the epoch ends the client's refresh families along with its
  access tokens.
- **Browser session:** a family minted under a
  [browser session](#browser-session) records its `sid`, and redemption
  refuses it once that session is revoked. A family with no `sid` (the device
  flow) has none to check.

### Access-token revocation (`jti` denylist + subject epoch)

Refresh-token revocation (above) stops a client minting _new_ access tokens;
this stops an _already-issued, still-unexpired_ access token — the leaked-token
case (#269). Every minted access token now carries a unique `jti` (RFC 7519
§4.1.7), which is a **revocation handle, not a single-use nonce** — normal reuse
of the one multi-use bearer is untouched. The shared store (`token-revocation-rust`,
its own `token_revocation` migration namespace on the same database) holds two
levers:

- **`revoked_jtis`** — a per-token denylist. `POST /authorization/revocations` with a
  `jti`, logout of the presented token, and a client revoking its own access
  token at `POST /oauth/revoke` (RFC 7009) add rows here.
- **`revocation_epochs`** — a per-subject `not_before`. Bumping it (via
  `POST /authorization/revocations` with a `subject`, or a grant revoke) invalidates
  every token that subject holds whose `iat` predates the bump, and every
  refresh family it holds that began before it — cheap bulk revocation with no
  per-issued-`jti` registry. `subject` is the `sub` claim
  (today the `client_id`), so revocation is per-client; per-device needs a
  device handle in the token (future work).

A third lever lives with the authorization server: a token whose
[`sid`](#sid-session-id) names a revoked [browser session](#browser-session).

A token is **revoked** iff its `jti` is denylisted, **or** its `iat` predates its
subject's epoch, **or** its `sid` names a revoked session. The auth gate
(`verify_auth_token_claims`) runs the full check on every Owner-gated and every
FHIR request; HFS additionally checks the per-`jti` denylist in-process
(defense-in-depth). Expired denylist rows are swept at startup and daily, once
they were revoked at least 24 hours ago, the longest a browser session's token
lives. See `docs/Origins/Explanation.md` for how this composes with the
one-origin model.

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
([HL7 spec](https://hl7.org/fhir/smart-app-launch/)). What the authorization server is
imitating. Concretely it adds:

- `patient` launch context (carried on `AuthorizationCode.patient` and
  the access-token JWT's `patient` claim).
- Scope strings shaped like `patient/Observation.read`.
- The `launch` parameter on `/oauth/authorize`: a
  [LaunchContext](#launchcontext) this server minted for the client.
- The `aud` parameter on `/oauth/authorize`: when present it must be the
  server's origin, `https://<domain>`, which is also its FHIR base, else
  `invalid_request`. The token's `aud` claim is the server's origin (see
  [`iss` and `aud`](#iss-issuer-and-aud-audience)).

## See-also: where these concepts may overlap

A short index of pairs/triples flagged with **Open question** above,
collected for the next round:

1. **AuthorizationCode ↔ AuthorizationRequest** — same row at different
   stages? Could be one table with a richer `status` discriminator.
2. **AuthorizationRequest ↔ HTTP request gate** — both are "row pending
   an Owner decision." Candidate for a shared `pendingApprovals` shape.

## References

- [README](../authorization-core/README.md) — current tables and routes
- `apps/host/wildflower-server/authorization-server-rust/src/` — server implementation and storage
- `slices/authorization/authorization-core/src/http-api-definition/` — endpoint groups
- RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7519 (JWT), RFC 7517 (JWK),
  RFC 6750 (Bearer), RFC 5785 (`.well-known`), RFC 8628 (Device
  Authorization Flow)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
