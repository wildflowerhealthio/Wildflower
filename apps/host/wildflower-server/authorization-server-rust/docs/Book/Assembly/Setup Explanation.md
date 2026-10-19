# Setup

{{#covers apps/host/wildflower-server/authorization-server-rust/src/lib.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/config.rs}}

The authorization server isn't a process of its own. It is one slice of the Wildflower host, and **the host builds it once, at boot, with one call**: [`setup_authorization_server`](#setup_authorization_server). The host hands over what only it has (the shared database, the shared revocation store, its configuration, a channel to hear about pending consents on, and its say over how fast requests may start) and gets back a router to merge, the shared state its own gates need, and four in-process handles.

This page is that seam: the configuration, the constants that name the server's own clients and the Owner's authority, the call itself, the background sweeps it starts, and what the crate root re-exports for the host.

## `AuthorizationServerConfig`

What the host tells the server about itself. The live Tauri app reads most of it from its shared config and the server's record; standalone and test builds use the defaults below.

{{#code apps/host/wildflower-server/authorization-server-rust/src/config.rs AuthorizationServerConfig}}

| Field                           | What it decides                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_origin`                 | The server's origin, `https://<domain>`. Every token minted here carries it as both `iss` and `aud`, and the bearer gates accept no other.    |
| `host_app_client_scopes`        | What the host app's client may be granted, seeded as its allowed scopes. Not the Owner's authority, which is [`OWNER_SCOPES`](#owner_scopes). |
| `wildflower_host_app_client_id` | The host app's `client_id`: seeded as a server-defined client, and essential, so the Owner can't disable it.                                  |
| `fhir_ui_client_id`             | The FHIR server's web UI's `client_id`, seeded with `{server_origin}/ui/callback` as its one redirect.                                        |
| `launcher_base`                 | The hosted launcher, where logout lands the browser.                                                                                          |
| `authorization_app_base`        | The hosted Wildflower Authorization app, one of the places `/oauth/sign-in` may send a browser next.                                          |
| `launcher_url`                  | The launcher the host opens this server's launches in, another place a signed-in browser may be sent on to.                                   |
| `authorization_url`             | The Authorization app page the host opens for this server, the last such place.                                                               |

## `WILDFLOWER_HOST_APP_CLIENT_ID`

The host app's `client_id` when nothing else names it: the standalone and test fallback. The live app passes its own through the config, so the id can't drift from the host's.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs WILDFLOWER_HOST_APP_CLIENT_ID}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs default_wildflower_host_app_client_id}}

No unit test of its own; [`seeds_the_host_app_s_client_under_the_configured_id`](<Seeding Explanation.md#the-essential-clients>) shows seeding uses the configured id, not this one.

## `default_host_app_client_scopes`

What the host app's client may be granted by default: `openid` alone. **The host app is not the Owner**, so it holds no admin scope of its own.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs default_host_app_client_scopes}}

No unit test of its own; [`the_default_host_app_s_client_is_allowed_openid_only`](<Seeding Explanation.md#the-essential-clients>) seeds with it.

## `BROWSER_SESSION_CLIENT_ID`

**The client every signed-in browser's token is issued to.** The Owner's browser is signed in by the host app on its own device with a same-device sign-in code at `/oauth/sign-in`; any other browser pairs at `/oauth/pair` and the Owner approves it. Each holds a token whose `sub` is this client, so revoking this subject signs every browser out; one browser is signed out by revoking its session (its token's `sid`) or its token's `jti`.

It is essential, like the host app's client: it can't be disabled. Neither sign-in nor pairing is an OAuth flow, so it is seeded with no grant type, and `/oauth/token` never mints its token. Its allowed scopes are the Owner's, the most a browser session may hold.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs BROWSER_SESSION_CLIENT_ID}}

No unit test of its own; [`seeds_the_browser_session_client_with_the_owner_s_scopes`](<Seeding Explanation.md#the-essential-clients>) shows its row.

## `WILDFLOWER_WIDEST_SCOPES`

**The scopes that mark an Owner**: every FHIR resource at system level, and every Wildflower resource, each with every permission (`system/*.cruds`, `wildflower/*.cruds`). A token covering both covers every per-resource scope an `/authorization` route asks for, so the Owner passes every gate.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs WILDFLOWER_WIDEST_SCOPES}}

## `OWNER_SCOPES`

**The Owner's authority**: what an Owner session holds, what the Owner approves consents with, the most an approved browser may be granted, and the browser-session client's allowed scopes. An approval can't delegate a resource scope these don't cover.

It is the widest scopes plus `wildflower/launch`, the right to launch apps. That is a known scope, not a resource scope, so the `wildflower/*` wildcard doesn't cover it and it must be listed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs OWNER_SCOPES}}

`owner_scopes` renders them as wire strings.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs owner_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs tests::the_owner_s_scopes_cover_the_widest_scopes}}

A grant of the Owner's scopes covers every one of the widest scopes, so an Owner's token passes every `/authorization` gate.

## `setup_authorization_server`

**Build the server over the host's database, and start it working.** In order:

1. **Open and seed the store** ([`open_and_seed_store`](<Seeding Explanation.md#open_and_seed_store>)): run the migrations, make sure a signing key is active, and rewrite the server's own clients.
2. **Build the shared state** ([`AuthorizationServerState`](<Live Bindings Explanation.md#authorizationserverstate>)) from the config: the origin, the device page's URL, the guard on the two essential clients, the Owner's grant, the outstanding sign-in codes, where a signed-in browser may be sent, the start gate, and the last-seen throttle.
3. **Publish the newest pending consent** on `owner_approval_tx`. The channel's value doesn't survive a restart but the row does, so a request left pending across one is reported in the server's first detail, and the host notifies it.
4. **Start the background sweeps** below.
5. **Build the router**, whose routes are at `/.well-known/jwks.json`, `/oauth/*` and `/authorization/*`. The host merges it as it is.
6. **Build the in-process handles** the host keeps.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs setup_authorization_server}}

The host builds `revocation_store` once and passes the same store to the FHIR server's adapter, so **the authorization server's gates and the FHIR server read one denylist**. `authorization_start_gate` is asked whenever a request without a live browser session would start an authorization request; where no visitor can reach the server, the host passes [`AdmitEveryAuthorizationStart`](<Ports and Adapters Explanation.md#admiteveryauthorizationstart>). It fails only when opening or seeding the store fails.

No unit test of its own. Every integration test starts from it, through the harness's [`spin_up`](<../Integration Tests Explanation.md#spin_up>).

## `AuthorizationServer`

What the host gets back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs AuthorizationServer}}

| Field                             | What the host does with it                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`                          | Merges it into its own router, which the tunnel listener serves.                                                                                                        |
| `state`                           | Passes it to `authorization_server_auth_middleware`, the bearer gate on the FHIR server's routes.                                                                       |
| `launch_context_minter`           | Mints the SMART `launch` values its own launchers put in an app's launch URL ([`LaunchContextMinter`](<OAuth Bindings Explanation.md#launchcontextminter>)).            |
| `same_device_sign_in_code_minter` | Mints the one-time codes that sign the Owner's own browser in ([`SameDeviceSignInCodeMinter`](<OAuth Bindings Explanation.md#samedevicesignincodeminter>)).             |
| `pending_consent_watcher`         | Waits for a consent it opened a page for to be decided or expire, to close the page ([`PendingConsentWatcher`](<OAuth Bindings Explanation.md#pendingconsentwatcher>)). |
| `in_process_token_verifier`       | Verifies each FHIR request's bearer exactly as this server's gates do ([`InProcessTokenVerifier`](<Session Bindings Explanation.md#inprocesstokenverifier>)).           |

## The background sweeps

`setup_authorization_server` starts three loops on the runtime. None changes what the server honours: each either reclaims rows the read paths already refuse, or republishes what the store already says. Each one, after a long pause such as a suspend, runs once rather than catching up on the ticks it missed.

**The pending-consent reaper** republishes the newest pending consent every 15 seconds. Republishing otherwise happens only after a write, so without it an idle server would go on advertising a request that has expired. Its first tick is skipped, since setup has just published. The channel ignores a publish that changes nothing, so an idle server publishes nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs DEVICE_CONSENT_REAPER_INTERVAL}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_device_consent_reaper}}

**The retention sweep** deletes the rows past their retention window ([`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>)): once at startup, then daily, far finer than the coarsest window. It runs on a blocking thread, since getting a connection alone can wait out the pool's timeout. A failed sweep is logged and tried again the next day.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs RETENTION_SWEEP_INTERVAL}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_retention_sweep}}

**The revocation purge** drops denylist rows whose token has expired: once at startup, then daily. An expired token is refused anyway, so this only reclaims space. Its floor is [`LONGEST_BROWSER_SESSION_TTL`](<../Domain/Browser Session Explanation.md#longest_browser_session_ttl>), the longest any token minted here lives, so a row is never dropped while its token could still be live, even when the caller of `/authorization/revocations` gave too early an expiry.

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs REVOCATION_PURGE_INTERVAL}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_revocation_purge}}

## What the crate root re-exports

The host imports the crate root, not its modules. Beyond the items above, the root re-exports:

- **the store**: `SqliteGrantStore`, the persistence port `GrantStore` and `GrantTx`, and `DieselPool`, so the host can name the pool type without depending on diesel;
- **pending consents**: `NewestPendingConsent`, what the host is told about, and `ConsentKey`, what it waits on;
- **the gates and cookies**: `authorization_server_auth_middleware` and `AuthorizationServerAuthMiddleware`, `ensure_bearer_header`, `AuthorizationServerState`, and the browser-session cookie's name, header and helpers (`BROWSER_SESSION_COOKIE`, `BROWSER_SESSION_HEADER_VALUE`, `SESSION_HEADER`, `standing_browser_session`, `record_browser_session_cookie_use`, `browser_session_clearing_set_cookie`);
- **the in-process handles**: `LaunchContextMinter`, `SameDeviceSignInCodeMinter`, `PendingConsentWatcher`, `InProcessTokenVerifier`;
- **the start gate**: `AuthorizationStartGate`, which the host implements, and `AdmitEveryAuthorizationStart`;
- `grantable_admin_scopes`, every admin scope the `/authorization` surface enforces, which nothing outside the crate reads;
- in debug builds only, `seed_dev_app_clients` ([Seeding](<Seeding Explanation.md#seed_dev_app_clients>)).

The modules `config`, `crypto_util`, `db`, `domain` and `http` stay public too: the integration tests reach into some of them, and the crate's public doc links point into them.
